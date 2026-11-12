// `generateschema`: print / write the OpenAPI 3.1 document of the project's REST API.
import {
  type ArgumentParser,
  BaseCommand,
  CommandError,
  type CommandIO,
  tryGetContext,
  type UrlPatterns,
} from '@ghuri/core'
import { getEndpoints, type OpenAPIDocument } from './schemas/openapi'
import { SchemaView } from './schemas/views'
import { toYAML } from './schemas/yaml'

const FORMATS = ['openapi', 'openapi-json'] as const
type Format = (typeof FORMATS)[number]

/**
 * `ghuri generateschema [--file openapi.yaml] [--format openapi|openapi-json] [--title …] [--description …]
 * [--api-version …] [--url …] [--indent 2]` (DRF's `generateschema`).
 *
 * Documents `ROOT_URLCONF`. When it routes a `SchemaView`, that view's `title`, `version`, `description`,
 * `servers`, `patterns` and `prefix` are used, so the file matches what `/api/schema/` serves; the flags
 * override them. YAML by default (`--format openapi-json`, or a `--file` ending in `.json`, for JSON).
 */
export class GenerateSchemaCommand extends BaseCommand {
  static override help =
    'Generates an OpenAPI 3.1 schema of the REST API (YAML, or JSON with --format openapi-json).'

  /** URL patterns to document when not using settings (tests / programmatic use). */
  static patterns?: UrlPatterns

  override addArguments(parser: ArgumentParser): void {
    parser
      .option('--file <path>', { help: 'Write the schema to this file instead of stdout.' })
      .option('--format <format>', {
        help: "'openapi' (YAML, the default) or 'openapi-json'. Defaults to JSON when --file ends in .json.",
      })
      .option('--title <title>', { help: 'Title of the API (info.title).' })
      .option('--description <text>', { help: 'Description of the API (info.description).' })
      .option('--api-version <version>', { help: 'Version of the API (info.version).' })
      .option('--url <url>', { help: 'Base URL of the API (servers[0].url).' })
      .option('--indent <n>', { help: 'Indentation of the JSON output (default 2).' })
  }

  /** The `SchemaView` that builds the document: the first one routed in the urlconf, or a default one. */
  schemaView(patterns: UrlPatterns): SchemaView {
    const endpoint = getEndpoints(patterns).find(
      (e) => e.cls === SchemaView || e.cls?.prototype instanceof SchemaView,
    )
    const view: SchemaView = endpoint ? new endpoint.cls() : new SchemaView()
    if (endpoint) Object.assign(view, endpoint.initkwargs)
    if (!view.patterns) view.patterns = patterns
    view.cacheSchema = false
    return view
  }

  generate(args: Record<string, unknown>): OpenAPIDocument {
    const patterns =
      (this.constructor as typeof GenerateSchemaCommand).patterns ??
      (tryGetContext()?.settings?.ROOT_URLCONF as UrlPatterns | undefined)
    if (!patterns) throw new CommandError('Set ROOT_URLCONF in your settings.')
    const view = this.schemaView(patterns)
    if (args.title !== undefined) view.title = String(args.title)
    if (args.description !== undefined) view.description = String(args.description)
    if (args.apiVersion !== undefined) view.version = String(args.apiVersion)
    if (args.url !== undefined) view.servers = [{ url: String(args.url) }]
    return view.generate()
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const file = args.file as string | undefined
    const format = (args.format ??
      (file?.toLowerCase().endsWith('.json') ? 'openapi-json' : 'openapi')) as Format
    if (!FORMATS.includes(format)) {
      throw new CommandError(`Unknown format '${format}'. Choose 'openapi' (YAML) or 'openapi-json'.`)
    }
    const doc = this.generate(args)
    const indent = args.indent === undefined ? 2 : Number(args.indent)
    const output =
      format === 'openapi-json'
        ? `${JSON.stringify(doc, null, Number.isFinite(indent) ? indent : 2)}\n`
        : toYAML(doc)
    if (file) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(file, output, 'utf8')
      io.stdout(io.style.success(`Successfully wrote the OpenAPI schema to ${file}`))
      return 0
    }
    io.stdout(output.trimEnd())
    return 0
  }
}
