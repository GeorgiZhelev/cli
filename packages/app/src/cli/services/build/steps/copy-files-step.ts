import {getNestedValue} from './utils.js'
import {joinPath, dirname, extname, relativePath, basename} from '@shopify/cli-kit/node/path'
import {glob, copyFile, copyDirectoryContents, fileExists, mkdir} from '@shopify/cli-kit/node/fs'
import {z} from 'zod'
import type {BuildManifestStepOutput, ResolvedAsset, ResolvedAssets} from './build-manifest-step.js'
import type {BuildStep, BuildContext} from '../build-steps.js'

/**
 * Files strategy definition.
 *
 * Each entry in `files` is one of:
 * - `{source}` only: copy the directory into the output. When `preserveStructure`
 *   is true (default false) the directory itself is placed under its own name;
 *   otherwise its contents are merged into the output root.
 * - `{source, destination}`: copy the file to an explicit destination path.
 * - `{tomlKey}`: resolve a path from the extension's TOML config and copy its
 *   directory into the output root. Silently skipped when the key is absent.
 *   Respects `preserveStructure` the same way as `{source}`.
 *
 * `preserveStructure` defaults to `false` to preserve backwards-compatible behaviour.
 */
const FilesDefinitionSchema = z.object({
  files: z.array(
    z.union([z.object({source: z.string(), destination: z.string().optional()}), z.object({tomlKey: z.string()})]),
  ),
  preserveStructure: z.boolean().default(false),
})

/**
 * Pattern strategy definition.
 *
 * Selects files from a single source directory using glob patterns.
 */
const PatternDefinitionSchema = z.object({
  source: z.string().optional(),
  patterns: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  destination: z.string().optional(),
  preserveStructure: z.boolean().default(true),
})

/**
 * manifest_result strategy definition.
 *
 * Reads a `BuildManifestStepOutput` from a previous step's result in the build context
 * and copies all assets flagged `static: true` to the output directory.
 * Each static asset's `module` field is the source path (relative to the extension
 * directory) and its `filepath` field is the destination (relative to the output dir).
 */
const ManifestResultDefinitionSchema = z.object({
  /**
   * The `id` of the step whose manifest result to consume.
   * Defaults to `'build-manifest'`.
   */
  stepId: z.string().default('build-manifest'),
})

/**
 * Configuration schema for copy_files step.
 * Discriminated by strategy; definition shape is tied to the chosen strategy.
 */
const CopyFilesConfigSchema = z.discriminatedUnion('strategy', [
  z.object({
    strategy: z.literal('files'),
    definition: FilesDefinitionSchema,
  }),
  z.object({
    strategy: z.literal('pattern'),
    definition: PatternDefinitionSchema,
  }),
  z.object({
    strategy: z.literal('manifest_result'),
    definition: ManifestResultDefinitionSchema,
  }),
])

/**
 * Executes a copy_files build step.
 *
 * Supports two strategies:
 *
 * 1. **'files' strategy**: each entry in `definition.files` is either:
 *    - `{source}` — copy directory contents into the output root.
 *    - `{source, destination}` — copy a file to an explicit destination path.
 *    - `{tomlKey}` — resolve a path from the extension's TOML config and copy
 *      its directory contents into the output root; silently skipped if absent.
 *
 * 2. **'pattern' strategy**: glob-based file selection from a single source directory.
 */
export async function executeCopyFilesStep(step: BuildStep, context: BuildContext): Promise<{filesCopied: number}> {
  const config = CopyFilesConfigSchema.parse(step.config)
  const {extension, options} = context
  // When outputPath is a file (e.g. index.js, index.wasm), the output directory is its
  // parent. When outputPath has no extension, it IS the output directory (copy_files mode
  // extensions where outputPath points to a bundle directory, not a single file).
  const outputDir = extname(extension.outputPath) ? dirname(extension.outputPath) : extension.outputPath

  switch (config.strategy) {
    case 'files': {
      return copyFilesList(
        config.definition.files,
        extension.directory,
        outputDir,
        context,
        options,
        config.definition.preserveStructure,
      )
    }
    case 'pattern': {
      const {definition} = config

      if (!definition.source) {
        throw new Error(`Build step "${step.displayName}" requires a source`)
      }

      const sourceDir = joinPath(extension.directory, definition.source)
      const resolvedPatterns = definition.patterns ?? ['**/*']
      const resolvedIgnore = definition.ignore ?? []
      const destinationDir = definition.destination ? joinPath(outputDir, definition.destination) : outputDir

      return copyByPattern(
        sourceDir,
        destinationDir,
        resolvedPatterns,
        resolvedIgnore,
        definition.preserveStructure,
        options,
      )
    }

    case 'manifest_result': {
      return copyStaticAssetsFromManifest(config.definition.stepId, outputDir, context)
    }
  }
}

/**
 * Files strategy — processes a mixed list of `source` and `tomlKey` entries.
 */
async function copyFilesList(
  files: ({source: string; destination?: string} | {tomlKey: string})[],
  baseDir: string,
  outputDir: string,
  context: BuildContext,
  options: {stdout: NodeJS.WritableStream},
  preserveStructure: boolean,
): Promise<{filesCopied: number}> {
  const counts = await Promise.all(
    files.map(async (entry) => {
      if ('tomlKey' in entry) {
        return copyTomlKeyEntry(entry.tomlKey, baseDir, outputDir, context, options, preserveStructure)
      }
      return copySourceEntry(entry.source, entry.destination, baseDir, outputDir, options, preserveStructure)
    }),
  )
  return {filesCopied: counts.reduce((sum, count) => sum + count, 0)}
}

/**
 * Handles a `{source}` or `{source, destination}` files entry.
 *
 * - No `destination`, `preserveStructure` false: copy directory contents into the output root.
 * - No `destination`, `preserveStructure` true: copy the directory under its own name in the output.
 * - With `destination`: copy the file to the explicit destination path (`preserveStructure` is ignored).
 */
async function copySourceEntry(
  source: string,
  destination: string | undefined,
  baseDir: string,
  outputDir: string,
  options: {stdout: NodeJS.WritableStream},
  preserveStructure: boolean,
): Promise<number> {
  const sourcePath = joinPath(baseDir, source)
  const exists = await fileExists(sourcePath)
  if (!exists) {
    throw new Error(`Source does not exist: ${sourcePath}`)
  }

  if (destination !== undefined) {
    const destPath = joinPath(outputDir, destination)
    await mkdir(dirname(destPath))
    await copyFile(sourcePath, destPath)
    options.stdout.write(`Copied ${source} to ${destination}\n`)
    return 1
  }

  const destDir = preserveStructure ? joinPath(outputDir, basename(sourcePath)) : outputDir
  await copyDirectoryContents(sourcePath, destDir)
  const copied = await glob(['**/*'], {cwd: destDir, absolute: false})
  const msg = preserveStructure
    ? `Copied ${source} to ${basename(sourcePath)}\n`
    : `Copied contents of ${source} to output root\n`
  options.stdout.write(msg)
  return copied.length
}

/**
 * Handles a `{tomlKey}` files entry.
 *
 * Resolves the key from the extension's TOML config. String values and string
 * arrays are each used as source paths. Unresolved keys and missing paths are
 * skipped silently with a log message.
 */
async function copyTomlKeyEntry(
  key: string,
  baseDir: string,
  outputDir: string,
  context: BuildContext,
  options: {stdout: NodeJS.WritableStream},
  preserveStructure: boolean,
): Promise<number> {
  const value = getNestedValue(context.extension.configuration, key)
  let paths: string[]
  if (typeof value === 'string') {
    paths = [value]
  } else if (Array.isArray(value)) {
    paths = value.filter((item): item is string => typeof item === 'string')
  } else {
    paths = []
  }

  if (paths.length === 0) {
    options.stdout.write(`No value for tomlKey '${key}', skipping\n`)
    return 0
  }

  const counts = await Promise.all(
    paths.map(async (sourcePath) => {
      const fullPath = joinPath(baseDir, sourcePath)
      const exists = await fileExists(fullPath)
      if (!exists) {
        options.stdout.write(`Warning: path '${sourcePath}' does not exist, skipping\n`)
        return 0
      }
      const destDir = preserveStructure ? joinPath(outputDir, basename(fullPath)) : outputDir
      await copyDirectoryContents(fullPath, destDir)
      const copied = await glob(['**/*'], {cwd: destDir, absolute: false})
      const msg = preserveStructure
        ? `Copied '${sourcePath}' to ${basename(fullPath)}\n`
        : `Copied contents of '${sourcePath}' to output root\n`
      options.stdout.write(msg)
      return copied.length
    }),
  )
  return counts.reduce((sum, count) => sum + count, 0)
}

/**
 * Pattern strategy: glob-based file selection.
 */
async function copyByPattern(
  sourceDir: string,
  outputDir: string,
  patterns: string[],
  ignore: string[],
  preserveStructure: boolean,
  options: {stdout: NodeJS.WritableStream},
): Promise<{filesCopied: number}> {
  const files = await glob(patterns, {
    absolute: true,
    cwd: sourceDir,
    ignore,
  })

  if (files.length === 0) {
    options.stdout.write(`Warning: No files matched patterns in ${sourceDir}\n`)
    return {filesCopied: 0}
  }

  await mkdir(outputDir)

  await Promise.all(
    files.map(async (filepath) => {
      const relPath = preserveStructure ? relativePath(sourceDir, filepath) : basename(filepath)
      const destPath = joinPath(outputDir, relPath)

      if (filepath === destPath) return

      await mkdir(dirname(destPath))
      await copyFile(filepath, destPath)
    }),
  )

  options.stdout.write(`Copied ${files.length} file(s) from ${sourceDir} to ${outputDir}\n`)
  return {filesCopied: files.length}
}

/**
 * manifest_result strategy — copies all static assets from a previous step's manifest result.
 *
 * Reads the named step's output from `context.stepResults`, collects every asset
 * with `static: true`, then copies each one from its `module` path (relative to the
 * extension directory) to its `filepath` path (relative to the output directory).
 *
 * Assets without a `module` field are skipped — they are considered already in place.
 * Both single-mode (`{assets}`) and forEach-mode (`{manifests}`) outputs are supported.
 */
async function copyStaticAssetsFromManifest(
  stepId: string,
  outputDir: string,
  context: BuildContext,
): Promise<{filesCopied: number}> {
  const stepResult = context.stepResults.get(stepId)

  if (!stepResult) {
    throw new Error(`Step '${stepId}' not found in step results. Ensure the build_manifest step runs before this step.`)
  }

  if (!stepResult.success) {
    throw new Error(`Step '${stepId}' didn't succeed — can't copy static assets from its manifest.`)
  }

  const output = stepResult.output as BuildManifestStepOutput
  const staticAssets = collectStaticAssets(output)

  if (staticAssets.length === 0) {
    context.options.stdout.write('No static assets found in build manifest\n')
    return {filesCopied: 0}
  }

  await Promise.all(
    staticAssets.map(async (asset) => {
      // Assets without a module path are not file-copy candidates
      if (!asset.module) return
      const sourcePath = joinPath(context.extension.directory, asset.module)
      const destPath = joinPath(outputDir, asset.filepath)
      await mkdir(dirname(destPath))
      await copyFile(sourcePath, destPath)
    }),
  )

  context.options.stdout.write(`Copied ${staticAssets.length} static asset(s) from build manifest\n`)
  return {filesCopied: staticAssets.length}
}

/**
 * Collects all assets with `static: true` from a BuildManifestStepOutput.
 * Flattens both single-mode and forEach-mode output shapes.
 */
function collectStaticAssets(output: BuildManifestStepOutput): ResolvedAsset[] {
  const allAssets: ResolvedAssets =
    'assets' in output
      ? output.assets
      : output.manifests.reduce<ResolvedAssets>((acc, manifest) => ({...acc, ...manifest.build_manifest.assets}), {})

  const result: ResolvedAsset[] = []
  for (const value of Object.values(allAssets)) {
    if (Array.isArray(value)) {
      result.push(...value.filter((asset) => asset.static === true))
    } else if (value.static === true) {
      result.push(value)
    }
  }
  return result
}
