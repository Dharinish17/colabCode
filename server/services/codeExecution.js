const LANGUAGE_IDS = Object.freeze({
  javascript: 102,
  python: 109,
  java: 91,
  c: 103,
  cpp: 105,
  go: 107,
  php: 98,
  ruby: 72,
});

const MAX_CODE_BYTES = 100000;
const MAX_OUTPUT_LENGTH = 16000;
const EXECUTION_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 750;

function limitOutput(value) {
  if (typeof value !== 'string') return '';
  return value.length > MAX_OUTPUT_LENGTH
    ? `${value.slice(0, MAX_OUTPUT_LENGTH)}\n[Output truncated]`
    : value;
}

function createJudge0Client() {
  const configuredUrl = process.env.JUDGE0_API_URL || 'https://ce.judge0.com';
  let baseUrl;
  try {
    baseUrl = new URL(configuredUrl);
  } catch {
    throw Object.assign(new Error('Code execution service URL is invalid.'), { status: 503 });
  }
  if (baseUrl.protocol !== 'https:') {
    throw Object.assign(new Error('Code execution service must use HTTPS.'), { status: 503 });
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  baseUrl.search = '';
  baseUrl.hash = '';

  const headers = { 'Content-Type': 'application/json' };
  const apiKey = process.env.JUDGE0_API_KEY;
  const authToken = process.env.JUDGE0_AUTH_TOKEN;
  if (apiKey) headers['X-RapidAPI-Key'] = apiKey;
  if (authToken) headers['X-Auth-Token'] = authToken;
  if (baseUrl.hostname.endsWith('.rapidapi.com')) {
    headers['X-RapidAPI-Host'] = process.env.JUDGE0_API_HOST || baseUrl.hostname;
  }

  return { baseUrl, headers };
}

async function readJsonResponse(response) {
  if (!response.ok) {
    throw Object.assign(new Error('The code execution service rejected the request.'), { status: 502 });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 100000) {
    throw Object.assign(new Error('The code execution service returned an oversized response.'), { status: 502 });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('The code execution service returned an invalid response.'), { status: 502 });
  }
}

async function executeCode({ code, language }) {
  if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw Object.assign(new Error('Code must be text no larger than 100 KB.'), { status: 400 });
  }
  const languageId = LANGUAGE_IDS[language];
  if (!languageId) {
    throw Object.assign(new Error('This language is not supported for execution.'), { status: 400 });
  }

  const { baseUrl, headers } = createJudge0Client();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);
  try {
    const submissionsUrl = new URL(baseUrl);
    submissionsUrl.pathname = `${baseUrl.pathname}/submissions`;
    submissionsUrl.search = '?base64_encoded=false&wait=false';
    const submissionResponse = await fetch(
      submissionsUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source_code: code,
          language_id: languageId,
          cpu_time_limit: 3,
          cpu_extra_time: 1,
          wall_time_limit: 5,
          memory_limit: 128000,
          max_file_size: 1024,
        }),
        signal: controller.signal,
      },
    );
    const submission = await readJsonResponse(submissionResponse);
    if (typeof submission.token !== 'string' || !submission.token) {
      throw Object.assign(new Error('The execution service did not return a submission token.'), { status: 502 });
    }

    const resultUrl = new URL(baseUrl);
    resultUrl.pathname = `${baseUrl.pathname}/submissions/${encodeURIComponent(submission.token)}`;
    resultUrl.search = '?base64_encoded=false';
    const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const response = await fetch(resultUrl, { headers, signal: controller.signal });
      const result = await readJsonResponse(response);
      const statusId = result.status?.id;
      if (statusId === 1 || statusId === 2) continue;
      if (!Number.isInteger(statusId) || typeof result.status?.description !== 'string') {
        throw Object.assign(new Error('The execution service returned an invalid result.'), { status: 502 });
      }

      const stderr = [result.stderr, result.compile_output]
        .filter((output) => typeof output === 'string' && output)
        .join('\n');
      return {
        status: result.status.description,
        stdout: limitOutput(result.stdout),
        stderr: limitOutput(stderr),
        executionTime: typeof result.time === 'string' || typeof result.time === 'number'
          ? String(result.time)
          : null,
      };
    }
    throw Object.assign(new Error('Code execution took too long. Please try again.'), { status: 504 });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('Code execution timed out. Please try again.'), { status: 504 });
    }
    if (error.status) throw error;
    console.error('Code execution service request failed:', error);
    throw Object.assign(new Error('Code execution service is unavailable. Please try again later.'), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { executeCode, LANGUAGE_IDS, MAX_CODE_BYTES };
