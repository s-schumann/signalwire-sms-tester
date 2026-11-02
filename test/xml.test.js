import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_MESSAGING_XML, XML_CONTENT_TYPE } from '../src/xml.js';

test('empty messaging cXML acknowledges without issuing a reply', () => {
  assert.equal(EMPTY_MESSAGING_XML, '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  assert.equal(XML_CONTENT_TYPE, 'application/xml; charset=utf-8');
  assert.doesNotMatch(EMPTY_MESSAGING_XML, /<Message/);
});
