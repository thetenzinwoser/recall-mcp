import { searchTool } from './search.js';
import { reindexTool, statusTool, indexTranscriptsTool } from './reindex.js';
import { getTranscriptTool } from './transcript.js';

export const tools = [
  searchTool,
  reindexTool,
  indexTranscriptsTool,
  statusTool,
  getTranscriptTool,
];
