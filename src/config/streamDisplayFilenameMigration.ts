import { configData, saveConfigFile } from './schema.js';

if (configData.streamDisplayConfig?.elements && !configData.streamDisplayConfig.elements['filename']) {
  configData.streamDisplayConfig.elements['filename'] = { id: 'filename', label: 'File Name', enabled: false, prefix: '📄' };
  const emptyRow = configData.streamDisplayConfig.lineGroups?.find((g: any) => g.elementIds?.length === 0);
  if (emptyRow) emptyRow.elementIds = ['filename'];
  saveConfigFile(configData);
  console.log('✅ Migrated streamDisplayConfig: added filename display element');
}
