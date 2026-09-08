export {}

import type { LicenseCredentials, LicenseDevScenario, LicenseSnapshot } from '@koubox/license-client'

declare global {
  interface Window {
    koubox: {
      get<T>(path: string): Promise<T>
      post<T>(path: string, body?: unknown): Promise<T>
      put<T>(path: string, body: unknown): Promise<T>
      del<T>(path: string): Promise<T>
      mediaUrl(filePath: string): string
      openDevTools(): Promise<boolean>
      logDebug(message: string, detail?: unknown): Promise<void>
      logError(message: string, detail?: unknown): Promise<void>
      logWarn(message: string, detail?: unknown): Promise<void>
      logInfo(message: string, detail?: unknown): Promise<void>
      licenseStatus(): Promise<LicenseSnapshot>
      licenseVerify(): Promise<LicenseSnapshot>
      licenseReplace(credentials: LicenseCredentials): Promise<LicenseSnapshot>
      licenseSimulate(scenario: LicenseDevScenario): Promise<LicenseSnapshot>
      licenseReset(): Promise<LicenseSnapshot>
      onLicenseStatus(callback: (snapshot: LicenseSnapshot) => void): () => void
      onLicenseEditorRequested(callback: () => void): () => void
      events<T>(path: string, onEvent: (event: T) => void): () => void
    }
  }
}
