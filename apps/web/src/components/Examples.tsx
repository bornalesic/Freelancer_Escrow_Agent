// An `examples` check: the agreed inputs and exact outputs, and the acceptance test file the agent runs
// (rendered by @escrow/shared, so the freelancer can run exactly the same file before delivering).
import { renderExamplesTest, type ExamplesCondition } from '@escrow/shared';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const testFileName = (c: ExamplesCondition) => `acceptance-${c.id}.test.mjs`;

export function ExamplesTable({ condition: c }: { condition: ExamplesCondition }) {
  const call = (input: string) => (c.target.type === 'js_function' ? `${c.target.export}(${JSON.stringify(input)})` : JSON.stringify(input));
  return (
    <div className="space-y-2">
      <table className="w-full table-fixed overflow-hidden rounded-lg border border-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-1.5 font-semibold">{c.target.type === 'js_function' ? 'Call' : `Input to ${c.target.command}`}</th>
            <th className="px-3 py-1.5 font-semibold">Must give</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 font-mono">
          {c.cases.map((x) => (
            <tr key={x.input}>
              <td className="truncate px-3 py-1.5 text-slate-700" title={call(x.input)}>{call(x.input)}</td>
              <td className="truncate px-3 py-1.5 text-slate-900" title={JSON.stringify(x.expected)}>{JSON.stringify(x.expected)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        onClick={() => download(testFileName(c), renderExamplesTest(c))}
        className="rounded-lg border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100"
        title={`Run it in your project folder: node --test ${testFileName(c)}`}
      >
        Download acceptance test
      </button>
    </div>
  );
}
