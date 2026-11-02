/**
 * Write the public API's OpenAPI document to docs/api/openapi.json.
 *
 *   npm run openapi:generate -w @talyn/backend
 *
 * The document is generated from the route declarations in
 * src/routes/public/. Commit the result: `openapi.contract.test.ts` fails when
 * the committed file and the routes disagree.
 */
import fs from 'node:fs';
import path from 'node:path';
// Load the workbench lifecycle first. The workbench services import each
// other in a cycle that resolves only when lifecycle.ts loads first.
import '../src/services/workbenches/lifecycle.js';
import { OPENAPI_DOCUMENT_PATH, serializeOpenApiDocument } from '../src/routes/public/openapi.js';
import { publicOpenApiDocument } from '../src/routes/public/routes.js';

fs.mkdirSync(path.dirname(OPENAPI_DOCUMENT_PATH), { recursive: true });
fs.writeFileSync(OPENAPI_DOCUMENT_PATH, serializeOpenApiDocument(publicOpenApiDocument()));
console.log(`wrote ${path.relative(process.cwd(), OPENAPI_DOCUMENT_PATH)}`);
