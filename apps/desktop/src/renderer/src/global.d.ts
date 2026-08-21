export {}

declare global {
  interface Window {
    koubox: {
      get<T>(path: string): Promise<T>
      post<T>(path: string, body?: unknown): Promise<T>
      put<T>(path: string, body: unknown): Promise<T>
      events<T>(path: string, onEvent: (event: T) => void): () => void
    }
  }
}
