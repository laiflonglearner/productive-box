export interface GraphQLResponse<T> {
  data: T;
}

const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export default async function githubQuery<T>(query: string): Promise<GraphQLResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${process.env.GH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });
    const response = (await res
      .json()
      .catch(() => ({ message: `GitHub HTTP ${res.status}: invalid JSON response` }))) as {
      data?: T;
      message?: string;
      errors?: { message: string; type?: string }[];
    };
    const message =
      response.errors?.map((error) => error.message).join('; ') || response.message || `GitHub HTTP ${res.status}`;
    const rateLimited =
      res.status === 429 ||
      res.headers.get('x-ratelimit-remaining') === '0' ||
      /rate limit/i.test(message) ||
      response.errors?.some((error) => error.type === 'RATE_LIMITED');
    const transient = rateLimited || res.status >= 500;
    if (res.ok && !response.errors?.length && response.data != null) {
      return { data: response.data };
    }
    if (!transient || attempt >= MAX_RETRIES) {
      throw new Error(message);
    }
    const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000;
    const resetAt = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
    const delay = Math.max(
      retryAfter,
      rateLimited && res.headers.get('x-ratelimit-remaining') === '0' ? resetAt - Date.now() : 0,
      rateLimited ? 60_000 * 2 ** attempt : 1000 * 2 ** attempt,
    );
    // A long quota reset should fail the run safely instead of tying up the runner.
    if (delay > MAX_RETRY_DELAY_MS) {
      throw new Error(`${message}; retry after ${new Date(Date.now() + delay).toISOString()}`);
    }
    await pause(delay);
  }
}
