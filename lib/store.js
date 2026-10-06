export async function redis(command) {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw Object.assign(
      new Error(
        'Storage is not configured. Follow the deployment guide to connect Upstash Redis.'
      ),
      { status: 503 }
    );
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error('Storage unavailable');
  }

  const data = await response.json();

  if (data.error) {
    throw new Error('Storage operation failed');
  }

  return data.result;
}
