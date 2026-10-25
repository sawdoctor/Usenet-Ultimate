import { configData } from '../config/index.js';

// Stremio keys an installed addon by its manifest id, so each deployment needs its own.
export const addonIdentity = {
  get id() {
    return process.env.ADDON_ID || configData.addonId || 'com.usenetultimate.addon';
  },
  get name() {
    return process.env.ADDON_NAME || configData.addonName || 'Usenet Ultimate';
  },
};
