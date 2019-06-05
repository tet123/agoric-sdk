import {resolve} from './files';
import chalk from 'chalk';

export const ACCOUNT_JSON = `account.json`;
export const ALLOCATE_FRESH_CLUSTERS = false;
export const DEFAULT_BOOT_TOKENS = `1000000agmedallion`;
export const PLAYBOOK_WRAPPER = `./ansible-playbook.sh`;
export const SETUP_DIR = resolve(__dirname, '../setup');
export const SSH_TYPE = 'ecdsa';
export const CHAIN_HOME = process.env.AG_SETUP_COSMOS_HOME ? resolve(process.env.AG_SETUP_COSMOS_HOME) : "";
process.env.AG_SETUP_COSMOS_HOME = CHAIN_HOME;

export const playbook = (name, ...args) => {
  const fullPath = `${SETUP_DIR}/ansible/${name}.yml`;
  return [PLAYBOOK_WRAPPER, fullPath, ...args];
};

export const sleep = (seconds, why) => {
  console.error(chalk.yellow(`Waiting ${seconds} seconds`, why || ''));
  return new Promise((resolve, reject) => setInterval(resolve, 1000 * seconds));
};
