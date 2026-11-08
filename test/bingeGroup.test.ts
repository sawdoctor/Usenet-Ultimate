import test from 'node:test';
import assert from 'node:assert/strict';
import { configData } from '../src/config/index.js';
import { addonIdentity } from '../src/addon/identity.js';

const clearOverrides = () => {
  delete process.env.BINGE_GROUP;
  configData.bingeGroup = undefined;
};

test('binge group defaults to the original Usenet Ultimate group', () => {
  // Arrange
  clearOverrides();

  // Act
  const group = addonIdentity.bingeGroup;

  // Assert
  assert.equal(group, 'usenetultimate');
});

test('config file sets the binge group', () => {
  // Arrange
  clearOverrides();
  configData.bingeGroup = 'djstreams';

  // Act
  const group = addonIdentity.bingeGroup;

  // Assert
  assert.equal(group, 'djstreams');
  clearOverrides();
});

test('BINGE_GROUP overrides the config file', () => {
  // Arrange
  clearOverrides();
  configData.bingeGroup = 'from-file';
  process.env.BINGE_GROUP = 'from-env';

  // Act
  const group = addonIdentity.bingeGroup;

  // Assert
  assert.equal(group, 'from-env');
  clearOverrides();
});
