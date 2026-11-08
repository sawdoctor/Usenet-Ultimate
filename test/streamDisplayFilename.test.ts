import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStreamDisplay, type StreamDisplayData } from '../src/addon/streamDisplay.js';
import type { StreamDisplayConfig } from '../src/types.js';

const data: StreamDisplayData = {
  resolutionDisplay: '1080p', quality: 'WEB-DL', cleanTitle: 'Show', rawTitle: 'Show.S02E05.1080p.WEB-DL-GRP',
  encode: 'Unknown', displaySize: '2 GB', visualTag: 'Unknown', audioTag: 'Unknown', releaseGroup: 'Unknown',
  indexer: 'Idx', statusBadge: '', providersLine: '', edition: 'Standard', language: 'Unknown', age: '', bitrate: '',
  isSeasonPack: false,
};

function config(enabled: boolean): StreamDisplayConfig {
  return {
    nameElements: [],
    elements: {
      cleanTitle: { id: 'cleanTitle', label: 'Release Title', enabled: true, prefix: '' },
      filename: { id: 'filename', label: 'File Name', enabled, prefix: '📄' },
    },
    seasonPackPrefix: '📦',
    regularPrefix: '🎬',
    lineGroups: [
      { id: 'a', elementIds: ['cleanTitle'], indent: false },
      { id: 'b', elementIds: ['filename'], indent: true },
    ],
    cleanTitles: true,
  };
}

test('filename element shows the raw release name on its own line', () => {
  assert.equal(buildStreamDisplay(data, config(true)).title, '🎬 Show\n  📄 Show.S02E05.1080p.WEB-DL-GRP');
});

test('filename element is hidden when disabled', () => {
  assert.equal(buildStreamDisplay(data, config(false)).title, '🎬 Show');
});
