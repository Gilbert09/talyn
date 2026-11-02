import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * The one `z` the public API schemas import. `.openapi()` names a schema as a
 * component of the generated spec, so it must be added before any schema
 * module runs; importing `z` from here makes that order hold.
 */
extendZodWithOpenApi(z);

export { z };
