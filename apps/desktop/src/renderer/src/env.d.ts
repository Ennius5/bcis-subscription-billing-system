///<reference types="vite/client" />
import type { BcisApi } from "../../preload/index";

declare global {
  interface Window {
    bcis: BcisApi;
  }
}

export {};