import { describe, expect, it } from 'vitest'

import { WalletError } from '../src/mock-wallet.ts'
import {
  countFreeUtxos,
  flattenAssets,
  isOpenInvoice,
  kindName,
  statusName,
  toAssetBalance,
  toSdkAmount,
  toTransferSummary,
  transferAmount,
  translateError,
  type RgbTransferRow,
  type RgbUnspent,
} from '../src/rgb-mapping.ts'

// Rows as the RGB SDK returned them on regtest (~/scratch/wdk-probe/probe-shapes.mjs), trimmed to the
// fields we read. Note the strings where the .d.ts declares numeric enums.
const ASSET = 'rgb:8kkpUAks-nak7KUD-TyGatmD-XnaDp7b-gJcBL55-Lr~iybY'
const TXID = '24dbcac77e9cc41c9c8aab91705242f75ca93ee7298c1c217552fd5d44e845a2'
const RECIPIENT = 'bcrt:utxob:Els46vSy-8Bf_Sfk-8Rh3JI8-3VBWX23-AHmm3uV-FeqNK5B-mp6cj'
const CREATED = 1792259001

function row(over: Partial<RgbTransferRow>): RgbTransferRow {
  return {
    idx: 1,
    batchTransferIdx: 1,
    createdAt: CREATED,
    status: 'WaitingCounterparty',
    kind: 'ReceiveBlind',
    requestedAssignment: { Fungible: 100_000_000 },
    assignments: [],
    txid: null,
    recipientId: RECIPIENT,
    ...over,
  }
}

/** Created by receiveAsset(), nobody has paid it yet. */
const openInvoice = row({})
/** The recipient's refresh pulled the consignment in. */
const pickedUp = row({ status: 'WaitingConfirmations', assignments: [{ Fungible: 100_000_000 }], txid: TXID })
/** The sender's row: requestedAssignment is the payment, assignments the change. */
const settledSend = row({
  idx: 2,
  batchTransferIdx: 2,
  kind: 'Send',
  status: 'Settled',
  requestedAssignment: { Fungible: 100_000_000 },
  assignments: [{ Fungible: 999_900_000_000 }],
  txid: TXID,
})
/** Invoice for 2, paid 1 -- rgb-lib settles it anyway. */
const underpaid = row({
  idx: 5,
  status: 'Settled',
  requestedAssignment: { Fungible: 2_000_000 },
  assignments: [{ Fungible: 1_000_000 }],
  txid: TXID,
})

describe('transfer rows', () => {
  it('treats an invoice nobody has paid as an invoice, not a transfer', () => {
    expect(isOpenInvoice(openInvoice)).toBe(true)
    expect(isOpenInvoice(row({ status: 'Failed' }))).toBe(true) // expired unpaid
    expect(isOpenInvoice(pickedUp)).toBe(false)
    expect(isOpenInvoice(settledSend)).toBe(false)
  })

  it('maps a settled send to the amount sent, not the change', () => {
    expect(toTransferSummary(settledSend, ASSET)).toEqual({
      id: '2',
      direction: 'outgoing',
      assetId: ASSET,
      amount: '100000000',
      status: 'settled',
      rawStatus: 'Settled',
      txid: TXID,
      recipientId: RECIPIENT,
      createdAt: new Date(CREATED * 1000).toISOString(),
    })
  })

  it('reports what actually arrived, so an underpayment is visible to the agent', () => {
    expect(transferAmount(underpaid)).toBe(1_000_000n)
    expect(toTransferSummary(underpaid, ASSET)).toMatchObject({ direction: 'incoming', amount: '1000000', status: 'settled' })
  })

  it('reports both waiting states as pending and keeps the raw status', () => {
    expect(toTransferSummary(pickedUp, ASSET)).toMatchObject({ status: 'pending', rawStatus: 'WaitingConfirmations', txid: TXID })
    expect(toTransferSummary(openInvoice, ASSET)).toMatchObject({ status: 'pending', rawStatus: 'WaitingCounterparty' })
    expect(toTransferSummary(openInvoice, ASSET)).not.toHaveProperty('txid')
  })

  it('also accepts the numeric enums the .d.ts declares', () => {
    expect(statusName(2)).toBe('Settled')
    expect(kindName(3)).toBe('Send')
    expect(toTransferSummary(row({ ...settledSend, status: 2, kind: 3 }), ASSET)).toMatchObject({ direction: 'outgoing', status: 'settled' })
  })

  it('never reports an unknown status as settled', () => {
    expect(toTransferSummary(row({ ...pickedUp, status: 'SomethingNew' }), ASSET)).toMatchObject({ status: 'pending', rawStatus: 'SomethingNew' })
  })

  it('refuses an amount a JS number cannot hold exactly', () => {
    expect(() => transferAmount(row({ ...pickedUp, assignments: [{ Fungible: 2 ** 53 }] }))).toThrow(WalletError)
  })
})

describe('balances, assets and UTXOs', () => {
  it('turns balances into decimal strings', () => {
    expect(toAssetBalance(ASSET, { settled: 64_000_000, future: 57_000_000, spendable: 0 }, 'TUSDT')).toEqual({
      assetId: ASSET,
      ticker: 'TUSDT',
      settled: '64000000',
      future: '57000000',
      spendable: '0',
    })
  })

  it('leaves the ticker out when there is none', () => {
    expect(toAssetBalance(ASSET, { settled: 0, future: 0, spendable: 0 })).not.toHaveProperty('ticker')
  })

  it('flattens the listAssets() groups', () => {
    const asset = { assetId: ASSET, ticker: 'TUSDT', balance: { settled: 1, future: 1, spendable: 1 } }
    expect(flattenAssets({ nia: [asset], uda: [], cfa: [], ifa: null })).toEqual([asset])
  })

  it('counts only colorable, empty UTXOs that no open invoice has reserved', () => {
    const unspents: RgbUnspent[] = [
      { utxo: { colorable: false }, rgbAllocations: [] },
      { utxo: { colorable: true }, rgbAllocations: [], pendingBlinded: 0 },
      { utxo: { colorable: true }, rgbAllocations: [{ assetId: ASSET }] },
      { utxo: { colorable: true }, rgbAllocations: [], pendingBlinded: 1 },
    ]
    expect(countFreeUtxos(unspents)).toBe(1)
  })
})

describe('amounts going into the SDK', () => {
  it('converts a decimal string to an exact number', () => {
    expect(toSdkAmount('100000000', 'amount')).toBe(100_000_000)
    expect(toSdkAmount(String(Number.MAX_SAFE_INTEGER), 'amount')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('refuses fractions and anything above 2^53 - 1', () => {
    expect(() => toSdkAmount('1.5', 'amount')).toThrow(WalletError)
    expect(() => toSdkAmount('9007199254740993', 'amount')).toThrow(/more than the RGB SDK can take/)
  })
})

describe('errors', () => {
  it('says an already-paid invoice is already paid, and keeps the rgb-lib text', () => {
    const err = translateError(new Error('RGB transfer failed: RgbLib(RecipientIDAlreadyUsed)'))
    expect(err).toBeInstanceOf(WalletError)
    expect((err as Error).message).toBe('this invoice has already been paid [RgbLib(RecipientIDAlreadyUsed)]')
  })

  it('explains InsufficientAssignments', () => {
    const err = translateError(new Error('RgbLib(InsufficientAssignments { asset_id: "rgb:x", available: AssignmentsCollection { fungible: 0 } })'))
    expect((err as Error).message).toMatch(/^not enough of the asset is spendable/)
  })

  it('leaves infrastructure errors alone', () => {
    const err = new Error('Failed to establish online connection')
    expect(translateError(err)).toBe(err)
  })
})
