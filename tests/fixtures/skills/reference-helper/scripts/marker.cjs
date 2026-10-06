// Test sentinel: importing or validating this package must never run this script.
require('node:fs').writeFileSync('SKILL_SCRIPT_EXECUTED', 'unexpected execution');
