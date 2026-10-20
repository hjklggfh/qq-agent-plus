import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInlineToolCalls } from '../src/tools/inline-tools.js';

test('arg_key/arg_value tool text preserves JSON array arguments', () => {
  assert.deepEqual(parseInlineToolCalls(
    '<tool_call>send_message<arg_key>messages</arg_key><arg_value>["行 能吃就成"]</arg_value></tool_call>'
  ), [{ name: 'send_message', args: { messages: ['行 能吃就成'] } }]);
});

test('arg tags inside commentary are not treated as a tool call', () => {
  assert.deepEqual(parseInlineToolCalls(
    '<tool_call>maybe send_message<arg_key>messages</arg_key><arg_value>["x"]</arg_value></tool_call>'
  ), []);
  assert.deepEqual(parseInlineToolCalls(
    '<tool_call>send_message<arg_key>messages</arg_key><arg_value>["x"]</arg_value>extra</tool_call>'
  ), []);
});
