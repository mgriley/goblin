/**
 * Tracks in-flight request/response round-trips over any transport that has an
 * async "send" and a separate "a message arrived" event (a worker, a socket, a
 * child process over IPC). The transport carries no notion of which reply
 * answers which request, so the tracker hands out a unique numeric `id` per
 * request, holds the pending promise, and settles it when a response with that
 * `id` comes back — with optional per-request timeouts and a bulk reject for
 * when the transport dies.
 *
 * The tracker never touches the transport directly. You give it a `sendFunc` at
 * construction that stamps the allocated `id` onto the payload and transmits
 * it; from your receive handler you call {@link resolve}/{@link reject} with the
 * `id` echoed back in the response.
 */

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AsyncRequestTrackerOptions {
  /**
   * Noun used in the default timeout error ("<label> timed out after Nms").
   * Defaults to "request".
   */
  label?: string;
}

/**
 * @typeParam TPayload - the request value passed to {@link request} and handed
 *   to `sendFunc` for transmission.
 * @typeParam TResult - the value an awaited {@link request} resolves to.
 */
export class AsyncRequestTracker<TPayload = unknown, TResult = unknown> {
  private readonly pending = new Map<number, Pending<TResult>>();
  private nextId = 1;
  private readonly label: string;

  constructor(
    private readonly sendFunc: (id: number, payload: TPayload) => void,
    options: AsyncRequestTrackerOptions = {},
  ) {
    this.label = options.label ?? "request";
  }

  /**
   * Allocate a fresh id, hand `(id, payload)` to `sendFunc` to transmit, and
   * return a promise that settles when {@link resolve}/{@link reject} is called
   * with that id — or rejects on its own once `timeoutMs` elapses (a timeout
   * only stops us waiting; it does not cancel work already in flight on the
   * transport).
   */
  request(payload: TPayload, timeoutMs?: number): Promise<TResult> {
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      const entry: Pending<TResult> = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.sendFunc(id, payload);
    });
  }

  /** Resolve the request with the given id. No-op if it is unknown/expired. */
  resolve(id: number, value: TResult): void {
    this.take(id)?.resolve(value);
  }

  /** Reject the request with the given id. No-op if it is unknown/expired. */
  reject(id: number, err: Error): void {
    this.take(id)?.reject(err);
  }

  /** Reject every outstanding request, e.g. when the transport dies. */
  rejectAll(err: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** Number of requests still awaiting a response. */
  get size(): number {
    return this.pending.size;
  }

  /** Remove a pending entry and clear its timer, returning it if present. */
  private take(id: number): Pending<TResult> | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }
}
