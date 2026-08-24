export {}

declare global {
  interface Window {
    koubox: {
      get<T>(path: string): Promise<T>
      post<T>(path: string, body?: unknown): Promise<T>
      put<T>(path: string, body: unknown): Promise<T>
      del<T>(path: string): Promise<T>
      mediaUrl(filePath: string): string
      openDevTools(): Promise<boolean>
      events<T>(path: string, onEvent: (event: T) => void): () => void
    }
  }
}
