import * as fs from "fs";
import * as path from "path";

import * as core from "@actions/core";
import * as toolrunner from "@actions/exec/lib/toolrunner";
import * as safeWhich from "@chrisgavin/safe-which";
import { JSONSchemaForNPMPackageJsonFiles } from "@schemastore/package";

import type { Config } from "./config-utils";
import {
  doesDirectoryExist,
  getCodeQLDatabasePath,
  getRequiredEnvParam,
  ConfigurationError,
} from "./util";

// eslint-disable-next-line import/no-commonjs, @typescript-eslint/no-require-imports
const pkg = require("../package.json") as JSONSchemaForNPMPackageJsonFiles;

/**
 * Wrapper around core.getInput for inputs that always have a value.
 * Also see getOptionalInput.
 *
 * This allows us to get stronger type checking of required/optional inputs.
 */
export const getRequiredInput = function (name: string): string {
  const value = core.getInput(name);
  if (!value) {
    throw new ConfigurationError(`Input required and not supplied: ${name}`);
  }
  return value;
};

/**
 * Wrapper around core.getInput that converts empty inputs to undefined.
 * Also see getRequiredInput.
 *
 * This allows us to get stronger type checking of required/optional inputs.
 */
export const getOptionalInput = function (name: string): string | undefined {
  const value = core.getInput(name);
  return value.length > 0 ? value : undefined;
};

export function getTemporaryDirectory(): string {
  const value = process.env["CODEQL_ACTION_TEMP"];
  return value !== undefined && value !== ""
    ? value
    : getRequiredEnvParam("RUNNER_TEMP");
}

async function runGitCommand(
  checkoutPath: string | undefined,
  args: string[],
  customErrorMessage: string,
): Promise<string> {
  let stdout = "";
  let stderr = "";
  core.debug(`Running git command: git ${args.join(" ")}`);
  try {
    await new toolrunner.ToolRunner(await safeWhich.safeWhich("git"), args, {
      silent: true,
      listeners: {
        stdout: (data) => {
          stdout += data.toString();
        },
        stderr: (data) => {
          stderr += data.toString();
        },
      },
      cwd: checkoutPath,
    }).exec();
    return stdout;
  } catch (error) {
    let reason = stderr;
    if (stderr.includes("not a git repository")) {
      reason =
        "The checkout path provided to the action does not appear to be a git repository.";
    }
    core.info(`git call failed. ${customErrorMessage} Error: ${reason}`);
    throw error;
  }
}

/**
 * Gets the SHA of the commit that is currently checked out.
 */
export const getCommitOid = async function (
  checkoutPath: string,
  ref = "HEAD",
): Promise<string> {
  // Try to use git to get the current commit SHA. If that fails then
  // log but otherwise silently fall back to using the SHA from the environment.
  // The only time these two values will differ is during analysis of a PR when
  // the workflow has changed the current commit to the head commit instead of
  // the merge commit, which must mean that git is available.
  // Even if this does go wrong, it's not a huge problem for the alerts to
  // reported on the merge commit.
  try {
    const stdout = await runGitCommand(
      checkoutPath,
      ["rev-parse", ref],
      "Continuing with commit SHA from user input or environment.",
    );
    return stdout.trim();
  } catch {
    return getOptionalInput("sha") || getRequiredEnvParam("GITHUB_SHA");
  }
};

/**
 * If the action was triggered by a pull request, determine the commit sha at
 * the head of the base branch, using the merge commit that this workflow analyzes.
 * Returns undefined if run by other triggers or the base branch commit cannot be
 * determined.
 */
export const determineBaseBranchHeadCommitOid = async function (
  checkoutPathOverride?: string,
): Promise<string | undefined> {
  if (getWorkflowEventName() !== "pull_request") {
    return undefined;
  }

  const mergeSha = getRequiredEnvParam("GITHUB_SHA");
  const checkoutPath =
    checkoutPathOverride ?? getOptionalInput("checkout_path");

  try {
    let commitOid = "";
    let baseOid = "";
    let headOid = "";

    const stdout = await runGitCommand(
      checkoutPath,
      ["show", "-s", "--format=raw", mergeSha],
      "Will calculate the base branch SHA on the server.",
    );

    for (const data of stdout.split("\n")) {
      if (data.startsWith("commit ") && commitOid === "") {
        commitOid = data.substring(7);
      } else if (data.startsWith("parent ")) {
        if (baseOid === "") {
          baseOid = data.substring(7);
        } else if (headOid === "") {
          headOid = data.substring(7);
        }
      }
    }

    // Let's confirm our assumptions: We had a merge commit and the parsed parent data looks correct
    if (
      commitOid === mergeSha &&
      headOid.length === 40 &&
      baseOid.length === 40
    ) {
      return baseOid;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Deepen the git history of the given ref by one level. Errors are logged.
 *
 * This function uses the `checkout_path` to determine the repository path and
 * works only when called from `analyze` or `upload-sarif`.
 */
export const deepenGitHistory = async function () {
  try {
    await runGitCommand(
      getOptionalInput("checkout_path"),
      ["fetch", "--no-tags", "--deepen=1"],
      "Cannot deepen the shallow repository.",
    );
  } catch {
    // Errors are already logged by runGitCommand()
  }
};

/**
 * Fetch the given remote branch. Errors are logged.
 *
 * This function uses the `checkout_path` to determine the repository path and
 * works only when called from `analyze` or `upload-sarif`.
 */
export const gitFetch = async function (branch: string, extraFlags: string[]) {
  try {
    await runGitCommand(
      getOptionalInput("checkout_path"),
      ["fetch", "--no-tags", ...extraFlags, "origin", `${branch}:${branch}`],
      `Cannot fetch ${branch}.`,
    );
  } catch {
    // Errors are already logged by runGitCommand()
  }
};

/**
 * Compute the all merge bases between the given refs. Returns an empty array
 * if no merge base is found, or if there is an error.
 *
 * This function uses the `checkout_path` to determine the repository path and
 * works only when called from `analyze` or `upload-sarif`.
 */
export const getAllGitMergeBases = async function (
  refs: string[],
): Promise<string[]> {
  try {
    const stdout = await runGitCommand(
      getOptionalInput("checkout_path"),
      ["merge-base", "--all", ...refs],
      `Cannot get merge base of ${refs}.`,
    );
    return stdout.trim().split("\n");
  } catch {
    return [];
  }
};

/**
 * Compute the diff hunk headers between the two given refs.
 *
 * This function uses the `checkout_path` to determine the repository path and
 * works only when called from `analyze` or `upload-sarif`.
 *
 * @returns an array of diff hunk headers (one element per line), or undefined
 * if the action was not triggered by a pull request, or if the diff could not
 * be determined.
 */
export const getGitDiffHunkHeaders = async function (
  fromRef: string,
  toRef: string,
): Promise<string[] | undefined> {
  let stdout = "";
  try {
    stdout = await runGitCommand(
      getOptionalInput("checkout_path"),
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-renames",
        "--irreversible-delete",
        "-U0",
        fromRef,
        toRef,
      ],
      `Cannot get diff from ${fromRef} to ${toRef}.`,
    );
  } catch {
    return undefined;
  }

  const headers: string[] = [];
  for (const line of stdout.split("\n")) {
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@ ")
    ) {
      headers.push(line);
    }
  }
  return headers;
};

/**
 * Decode, if necessary, a file path produced by Git. See
 * https://git-scm.com/docs/git-config#Documentation/git-config.txt-corequotePath
 * for details on how Git encodes file paths with special characters.
 *
 * This function works only for Git output with `core.quotePath=false`.
 */
export const decodeGitFilePath = function (filePath: string): string {
  if (filePath.startsWith('"') && filePath.endsWith('"')) {
    filePath = filePath.substring(1, filePath.length - 1);
    return filePath.replace(
      /\\([abfnrtv\\"]|[0-7]{1,3})/g,
      (_match, seq: string) => {
        switch (seq[0]) {
          case "a":
            return "\x07";
          case "b":
            return "\b";
          case "f":
            return "\f";
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          case "v":
            return "\v";
          case "\\":
            return "\\";
          case '"':
            return '"';
          default:
            // Both String.fromCharCode() and String.fromCodePoint() works only
            // for constructing an entire character at once. If a Unicode
            // character is encoded as a sequence of escaped bytes, calling these
            // methods sequentially on the individual byte values would *not*
            // produce the original multi-byte Unicode character. As a result,
            // this implementation works only with the Git option core.quotePath
            // set to false.
            return String.fromCharCode(parseInt(seq, 8));
        }
      },
    );
  }
  return filePath;
};

/**
 * Get the ref currently being analyzed.
 */
export async function getRef(): Promise<string> {
  // Will be in the form "refs/heads/master" on a push event
  // or in the form "refs/pull/N/merge" on a pull_request event
  const refInput = getOptionalInput("ref");
  const shaInput = getOptionalInput("sha");
  const checkoutPath =
    getOptionalInput("checkout_path") ||
    getOptionalInput("source-root") ||
    getRequiredEnvParam("GITHUB_WORKSPACE");

  const hasRefInput = !!refInput;
  const hasShaInput = !!shaInput;
  // If one of 'ref' or 'sha' are provided, both are required
  if ((hasRefInput || hasShaInput) && !(hasRefInput && hasShaInput)) {
    throw new ConfigurationError(
      "Both 'ref' and 'sha' are required if one of them is provided.",
    );
  }

  const ref = refInput || getRefFromEnv();
  const sha = shaInput || getRequiredEnvParam("GITHUB_SHA");

  // If the ref is a user-provided input, we have to skip logic
  // and assume that it is really where they want to upload the results.
  if (refInput) {
    return refInput;
  }

  // For pull request refs we want to detect whether the workflow
  // has run `git checkout HEAD^2` to analyze the 'head' ref rather
  // than the 'merge' ref. If so, we want to convert the ref that
  // we report back.
  const pull_ref_regex = /refs\/pull\/(\d+)\/merge/;
  if (!pull_ref_regex.test(ref)) {
    return ref;
  }

  const head = await getCommitOid(checkoutPath, "HEAD");

  // in actions/checkout@v2+ we can check if git rev-parse HEAD == GITHUB_SHA
  // in actions/checkout@v1 this may not be true as it checks out the repository
  // using GITHUB_REF. There is a subtle race condition where
  // git rev-parse GITHUB_REF != GITHUB_SHA, so we must check
  // git rev-parse GITHUB_REF == git rev-parse HEAD instead.
  const hasChangedRef =
    sha !== head &&
    (await getCommitOid(
      checkoutPath,
      ref.replace(/^refs\/pull\//, "refs/remotes/pull/"),
    )) !== head;

  if (hasChangedRef) {
    const newRef = ref.replace(pull_ref_regex, "refs/pull/$1/head");
    core.debug(
      `No longer on merge commit, rewriting ref from ${ref} to ${newRef}.`,
    );
    return newRef;
  } else {
    return ref;
  }
}

function getRefFromEnv(): string {
  // To workaround a limitation of Actions dynamic workflows not setting
  // the GITHUB_REF in some cases, we accept also the ref within the
  // CODE_SCANNING_REF variable. When possible, however, we prefer to use
  // the GITHUB_REF as that is a protected variable and cannot be overwritten.
  let refEnv: string;
  try {
    refEnv = getRequiredEnvParam("GITHUB_REF");
  } catch (e) {
    // If the GITHUB_REF is not set, we try to rescue by getting the
    // CODE_SCANNING_REF.
    const maybeRef = process.env["CODE_SCANNING_REF"];
    if (maybeRef === undefined || maybeRef.length === 0) {
      throw e;
    }
    refEnv = maybeRef;
  }
  return refEnv;
}

export function getActionVersion(): string {
  return pkg.version!;
}

/**
 * Returns the name of the event that triggered this workflow.
 *
 * This will be "dynamic" for default setup workflow runs.
 */
export function getWorkflowEventName() {
  return getRequiredEnvParam("GITHUB_EVENT_NAME");
}

/**
 * Returns whether the current workflow is executing a local copy of the Action, e.g. we're running
 * a workflow on the codeql-action repo itself.
 */
export function isRunningLocalAction(): boolean {
  const relativeScriptPath = getRelativeScriptPath();
  return (
    relativeScriptPath.startsWith("..") || path.isAbsolute(relativeScriptPath)
  );
}

/**
 * Get the location where the Action is running from.
 *
 * This can be used to get the Action's name or tell if we're running a local Action.
 */
export function getRelativeScriptPath(): string {
  const runnerTemp = getRequiredEnvParam("RUNNER_TEMP");
  const actionsDirectory = path.join(path.dirname(runnerTemp), "_actions");
  return path.relative(actionsDirectory, __filename);
}

/** Returns the contents of `GITHUB_EVENT_PATH` as a JSON object. */
export function getWorkflowEvent(): any {
  const eventJsonFile = getRequiredEnvParam("GITHUB_EVENT_PATH");
  try {
    return JSON.parse(fs.readFileSync(eventJsonFile, "utf-8"));
  } catch (e) {
    throw new Error(
      `Unable to read workflow event JSON from ${eventJsonFile}: ${e}`,
    );
  }
}

function removeRefsHeadsPrefix(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * Returns whether we are analyzing the default branch for the repository.
 *
 * This first checks the environment variable `CODE_SCANNING_IS_ANALYZING_DEFAULT_BRANCH`. This
 * environment variable can be set in cases where repository information might not be available, for
 * example dynamic workflows.
 */
export async function isAnalyzingDefaultBranch(): Promise<boolean> {
  if (process.env.CODE_SCANNING_IS_ANALYZING_DEFAULT_BRANCH === "true") {
    return true;
  }

  // Get the current ref and trim and refs/heads/ prefix
  let currentRef = await getRef();
  currentRef = removeRefsHeadsPrefix(currentRef);

  const event = getWorkflowEvent();
  let defaultBranch = event?.repository?.default_branch;

  if (getWorkflowEventName() === "schedule") {
    defaultBranch = removeRefsHeadsPrefix(getRefFromEnv());
  }

  return currentRef === defaultBranch;
}

export async function printDebugLogs(config: Config) {
  for (const language of config.languages) {
    const databaseDirectory = getCodeQLDatabasePath(config, language);
    const logsDirectory = path.join(databaseDirectory, "log");
    if (!doesDirectoryExist(logsDirectory)) {
      core.info(`Directory ${logsDirectory} does not exist.`);
      continue; // Skip this language database.
    }

    const walkLogFiles = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.length === 0) {
        core.info(`No debug logs found at directory ${logsDirectory}.`);
      }
      for (const entry of entries) {
        if (entry.isFile()) {
          const absolutePath = path.resolve(dir, entry.name);
          core.startGroup(
            `CodeQL Debug Logs - ${language} - ${entry.name} from file at path ${absolutePath}`,
          );
          process.stdout.write(fs.readFileSync(absolutePath));
          core.endGroup();
        } else if (entry.isDirectory()) {
          walkLogFiles(path.resolve(dir, entry.name));
        }
      }
    };
    walkLogFiles(logsDirectory);
  }
}

export type UploadKind = "always" | "failure-only" | "never";

/**
 * Parses the `upload` input into an `UploadKind`, converting unspecified and deprecated upload
 * inputs appropriately.
 */
export function getUploadValue(input: string | undefined): UploadKind {
  switch (input) {
    case undefined:
    case "true":
    case "always":
      return "always";
    case "false":
    case "failure-only":
      return "failure-only";
    case "never":
      return "never";
    default:
      core.warning(
        `Unrecognized 'upload' input to 'analyze' Action: ${input}. Defaulting to 'always'.`,
      );
      return "always";
  }
}

/**
 * Get the workflow run ID.
 */
export function getWorkflowRunID(): number {
  const workflowRunIdString = getRequiredEnvParam("GITHUB_RUN_ID");
  const workflowRunID = parseInt(workflowRunIdString, 10);
  if (Number.isNaN(workflowRunID)) {
    throw new Error(
      `GITHUB_RUN_ID must define a non NaN workflow run ID. Current value is ${workflowRunIdString}`,
    );
  }
  if (workflowRunID < 0) {
    throw new Error(
      `GITHUB_RUN_ID must be a non-negative integer. Current value is ${workflowRunIdString}`,
    );
  }
  return workflowRunID;
}

/**
 * Get the workflow run attempt number.
 */
export function getWorkflowRunAttempt(): number {
  const workflowRunAttemptString = getRequiredEnvParam("GITHUB_RUN_ATTEMPT");
  const workflowRunAttempt = parseInt(workflowRunAttemptString, 10);
  if (Number.isNaN(workflowRunAttempt)) {
    throw new Error(
      `GITHUB_RUN_ATTEMPT must define a non NaN workflow run attempt. Current value is ${workflowRunAttemptString}`,
    );
  }
  if (workflowRunAttempt <= 0) {
    throw new Error(
      `GITHUB_RUN_ATTEMPT must be a positive integer. Current value is ${workflowRunAttemptString}`,
    );
  }
  return workflowRunAttempt;
}

export class FileCmdNotFoundError extends Error {
  constructor(msg: string) {
    super(msg);

    this.name = "FileCmdNotFoundError";
  }
}

/**
 * Tries to obtain the output of the `file` command for the file at the specified path.
 * The output will vary depending on the type of `file`, which operating system we are running on, etc.
 */
export const getFileType = async (filePath: string): Promise<string> => {
  let stderr = "";
  let stdout = "";

  let fileCmdPath: string;

  try {
    fileCmdPath = await safeWhich.safeWhich("file");
  } catch (e) {
    throw new FileCmdNotFoundError(
      `The \`file\` program is required, but does not appear to be installed. Please install it: ${e}`,
    );
  }

  try {
    // The `file` command will output information about the type of file pointed at by `filePath`.
    // For binary files, this may include e.g. whether they are static of dynamic binaries.
    // The `-L` switch instructs the command to follow symbolic links.
    await new toolrunner.ToolRunner(fileCmdPath, ["-L", filePath], {
      silent: true,
      listeners: {
        stdout: (data) => {
          stdout += data.toString();
        },
        stderr: (data) => {
          stderr += data.toString();
        },
      },
    }).exec();
    return stdout.trim();
  } catch (e) {
    core.info(
      `Could not determine type of ${filePath} from ${stdout}. ${stderr}`,
    );

    throw e;
  }
};

export function isSelfHostedRunner() {
  return process.env.RUNNER_ENVIRONMENT === "self-hosted";
}

/** Determines whether we are running in default setup. */
export function isDefaultSetup(): boolean {
  return getWorkflowEventName() === "dynamic";
}

export function prettyPrintInvocation(cmd: string, args: string[]): string {
  return [cmd, ...args].map((x) => (x.includes(" ") ? `'${x}'` : x)).join(" ");
}

/**
 * An error from a tool invocation, with associated exit code, stderr, etc.
 */
export class CommandInvocationError extends Error {
  constructor(
    public cmd: string,
    public args: string[],
    public exitCode: number | undefined,
    public stderr: string,
    public stdout: string,
  ) {
    const prettyCommand = prettyPrintInvocation(cmd, args);
    const lastLine = ensureEndsInPeriod(
      stderr.trim().split("\n").pop()?.trim() || "n/a",
    );
    super(
      `Failed to run "${prettyCommand}". ` +
        `Exit code was ${exitCode} and last log line was: ${lastLine} See the logs for more details.`,
    );
  }
}

export function ensureEndsInPeriod(text: string): string {
  return text[text.length - 1] === "." ? text : `${text}.`;
}

/**
 * A constant defining the maximum number of characters we will keep from
 * the programs stderr for logging.
 *
 * This serves two purposes:
 * 1. It avoids an OOM if a program fails in a way that results it
 *    printing many log lines.
 * 2. It avoids us hitting the limit of how much data we can send in our
 *    status reports on GitHub.com.
 */
const MAX_STDERR_BUFFER_SIZE = 20000;

/**
 * Runs a CLI tool.
 *
 * @returns Standard output produced by the tool.
 * @throws A `CommandInvocationError` if the tool exits with a non-zero status code.
 */
export async function runTool(
  cmd: string,
  args: string[] = [],
  opts: { stdin?: string; noStreamStdout?: boolean } = {},
): Promise<string> {
  let stdout = "";
  let stderr = "";
  if (!opts.noStreamStdout) {
    process.stdout.write(`[command]${cmd} ${args.join(" ")}\n`);
  }
  const exitCode = await new toolrunner.ToolRunner(cmd, args, {
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString("utf8");
        if (!opts.noStreamStdout) {
          process.stdout.write(data);
        }
      },
      stderr: (data: Buffer) => {
        let readStartIndex = 0;
        // If the error is too large, then we only take the last MAX_STDERR_BUFFER_SIZE characters
        if (data.length - MAX_STDERR_BUFFER_SIZE > 0) {
          // Eg: if we have MAX_STDERR_BUFFER_SIZE the start index should be 2.
          readStartIndex = data.length - MAX_STDERR_BUFFER_SIZE + 1;
        }
        stderr += data.toString("utf8", readStartIndex);
        // Mimic the standard behavior of the toolrunner by writing stderr to stdout
        process.stdout.write(data);
      },
    },
    silent: true,
    ...(opts.stdin ? { input: Buffer.from(opts.stdin || "") } : {}),
  }).exec();
  if (exitCode !== 0) {
    throw new CommandInvocationError(cmd, args, exitCode, stderr, stdout);
  }
  return stdout;
}

const persistedInputsKey = "persisted_inputs";

/**
 * Persists all inputs to the action as state that can be retrieved later in the post-action.
 * This would be simplified if actions/runner#3514 is addressed.
 * https://github.com/actions/runner/issues/3514
 */
export const persistInputs = function () {
  const inputEnvironmentVariables = Object.entries(process.env).filter(
    ([name]) => name.startsWith("INPUT_"),
  );
  core.saveState(persistedInputsKey, JSON.stringify(inputEnvironmentVariables));
};

/**
 * Restores all inputs to the action from the persisted state.
 */
export const restoreInputs = function () {
  const persistedInputs = core.getState(persistedInputsKey);
  if (persistedInputs) {
    for (const [name, value] of JSON.parse(persistedInputs)) {
      process.env[name] = value;
    }
  }
};
