/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_URL?: string;
  readonly VITE_PARTY_URL?: string;
  /** Exposed via `envPrefix` in vite.config.ts; only the projector view uses them. */
  readonly CLIENT_PARTY_URL?: string;
  readonly FREELANCER_PARTY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
