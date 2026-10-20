// node --test 的末尾常是统计行；只截最后 2000 字会丢掉失败用例和断言原因。
export function updateFailureDetail(result, { tests = false } = {}) {
  const output = [result?.stdout, result?.stderr].filter(Boolean).join('\n').trim();
  if (!tests) return output.slice(-2000);
  const marker = output.lastIndexOf('✖ failing tests:');
  const failedBlock = marker >= 0 ? output.slice(marker) : output;
  const names = [...failedBlock.matchAll(/^✖ (?!failing tests:)(.+)$/gm)]
    .map((match) => match[1].trim()).slice(0, 4);
  const causes = [...failedBlock.matchAll(/^\s*(?:AssertionError(?: \[[^\]]+\])?|Error|TypeError|SyntaxError):\s*(.+)$/gm)]
    .map((match) => match[1].trim()).slice(0, 3);
  if (names.length) return `失败用例：${names.join('；')}${causes.length ? `。原因：${causes.join('；')}` : ''}`.slice(0, 1800);
  const tapFailures = [...output.matchAll(/^not ok\s+\d+\s+-\s+(.+)$/gm)]
    .map((match) => match[1].trim()).slice(0, 4);
  if (tapFailures.length) return `失败用例：${tapFailures.join('；')}`.slice(0, 1800);
  return output.slice(-2000);
}
