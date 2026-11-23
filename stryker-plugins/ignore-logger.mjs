// stryker-plugins/ignore-logger.mjs

// Tells Stryker not to mutate inside logging calls (logger.warn({ id }, 'text'),
// log.info(...)). Flipping a log message or dropping a log field does not change
// what the program does, so those mutants can never be killed by a test that
// checks behaviour. They only drag the score down and bury the survivors that matter.
//
// Ignored mutants are reported as "ignored" and left out of the score, so the
// report says exactly how many were skipped. Only the names below are treated
// as loggers; everything else (error messages in API responses, for example)
// is still mutated.

import { PluginKind, declareClassPlugin } from '@stryker-mutator/api/plugin';

const LOGGER_NAMES = new Set(['logger', 'log', 'baseLogger']);

const isLoggerCall = (node) =>
  node?.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  node.callee.object.type === 'Identifier' &&
  LOGGER_NAMES.has(node.callee.object.name);

class LoggerCallIgnorer {
  shouldIgnore(path) {
    // the call itself (its arguments, message text)...
    if (path.isCallExpression() && isLoggerCall(path.node)) return 'logging call';
    // ...and the statement that is only that call (so "delete the log line" is skipped too)
    if (path.isExpressionStatement() && isLoggerCall(path.node.expression)) return 'logging call';
    return undefined;
  }
}

export const strykerPlugins = [
  declareClassPlugin(PluginKind.Ignore, 'logger-calls', LoggerCallIgnorer),
];
