import test from 'node:test';
import assert from 'node:assert/strict';
import { configData } from '../src/config/index.js';
import { addonIdentity } from '../src/addon/identity.js';

const clearOverrides = () => {
  delete process.env.ADDON_ID;
  delete process.env.ADDON_NAME;
  configData.addonId = undefined;
  configData.addonName = undefined;
};

test('addon id and name default to Usenet Ultimate', () => {
  // Arrange
  clearOverrides();

  // Act
  const { id, name } = addonIdentity;

  // Assert
  assert.equal(id, 'com.usenetultimate.addon');
  assert.equal(name, 'Usenet Ultimate');
});

test('config file sets the addon id and name', () => {
  // Arrange
  clearOverrides();
  configData.addonId = 'com.djstreams.addon';
  configData.addonName = 'DJ Streams';

  // Act
  const { id, name } = addonIdentity;

  // Assert
  assert.equal(id, 'com.djstreams.addon');
  assert.equal(name, 'DJ Streams');
  clearOverrides();
});

test('environment variables override the config file', () => {
  // Arrange
  clearOverrides();
  configData.addonName = 'From File';
  process.env.ADDON_ID = 'com.env.addon';
  process.env.ADDON_NAME = 'From Env';

  // Act
  const { id, name } = addonIdentity;

  // Assert
  assert.equal(id, 'com.env.addon');
  assert.equal(name, 'From Env');
  clearOverrides();
});
