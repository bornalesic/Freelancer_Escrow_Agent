/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_URL?: string;
  /** This laptop's two party servers: everyone can enter as either role, each with its own wallet. */
  readonly VITE_CLIENT_PARTY_URL?: string;
  readonly VITE_FREELANCER_PARTY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
