import { AppConfig } from '@ghuri/core'
import { GenerateSchemaCommand } from './commands'

/** Add to `INSTALLED_APPS` (DRF's `'rest_framework'`) to get the `generateschema` command. */
export class RestFrameworkConfig extends AppConfig {
  name = 'rest_framework'
  override verboseName = 'REST framework'
  override commands = { generateschema: GenerateSchemaCommand }
}
