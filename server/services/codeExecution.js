const COMPILERS = Object.freeze({
  javascript: 'nodejs-20.17.0',
  python: 'cpython-3.13.8',
  java: 'openjdk-jdk-21+35',
  c: 'gcc-13.2.0-c',
  cpp: 'gcc-13.2.0',
  go: 'go-1.23.2',
  php: 'php-8.3.12',
  ruby: 'ruby-3.4.9',
});

const WAND_BOX_API_URL = 'https://wandbox.org/api/compile.json';
const MAX_CODE_BYTES = 100000;
const MAX_OUTPUT_LENGTH = 16000;
const EXECUTION_TIMEOUT_MS = 30000;

function limitOutput(value) {
  if (typeof value !== 'string') return '';
  return value.length > MAX_OUTPUT_LENGTH
    ? `${value.slice(0, MAX_OUTPUT_LENGTH)}\n[Output truncated]`
    : value;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 100000) {
    throw Object.assign(new Error('The code execution service returned an oversized response.'), { status: 502 });
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = JSON.parse(text);
      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        detail = ['error', 'message', 'detail', 'error_description']
          .map((key) => body[key])
          .find((value) => typeof value === 'string') || '';
      }
    } catch {
      if (text && !/^\s*</.test(text)) detail = text;
    }
    detail = detail.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    const errorDetail = detail ? `: ${detail}` : '';
    throw Object.assign(
      new Error(`The code execution service rejected the request (HTTP ${response.status}${errorDetail}).`),
      { status: 502 },
    );
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
  const compiler = COMPILERS[language];
  if (!compiler) {
    throw Object.assign(new Error('This language is not supported for execution.'), { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(WAND_BOX_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compiler, code, stdin: '', save: false }),
      signal: controller.signal,
    });
    const result = await readJsonResponse(response);
    if (
      typeof result.status !== 'string' ||
      typeof result.program_output !== 'string' ||
      typeof result.program_error !== 'string'
    ) {
      throw Object.assign(new Error('The code execution service returned an invalid result.'), { status: 502 });
    }

    const stderr = [
      result.compiler_error,
      result.program_error,
      ...(result.status !== '0' && !result.compiler_error && !result.program_error
        ? [result.compiler_message, result.program_message]
        : []),
    ].filter((output) => typeof output === 'string' && output).join('\n');
    return {
      status: result.status === '0' && !result.signal
        ? 'Success'
        : result.signal || `Exit code ${result.status}`,
      stdout: limitOutput(result.program_output),
      stderr: limitOutput(stderr),
      executionTime: String((Date.now() - startedAt) / 1000),
    };
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

module.exports = { executeCode, COMPILERS, MAX_CODE_BYTES };
