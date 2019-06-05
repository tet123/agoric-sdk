import {ACCOUNT_JSON, CHAIN_HOME, DEFAULT_BOOT_TOKENS, playbook, sleep, SSH_TYPE} from './setup';
import {exists, readFile, resolve, stat, streamFromString, createFile, unlink} from './files';
import {chdir, doRun, exec, needDoRun, shellEscape, shellMetaRegexp, setSilent} from './run';
import doInit from './init';

import {prompt} from 'inquirer';
import {stringify as djsonStringify} from 'deterministic-json';
import {createHash} from 'crypto';
import chalk from 'chalk';
import { Writable } from 'stream';

const AFTER_TERRAFORMING = ['hosts', `ssh_known_hosts.stamp`, `genesis.json`, `ssh_known_hosts`, `peers.txt`, `terraform.json`];

const provisionOutput = async () => {
  const jsonFile = `terraform.json`;
  let buf;
  if (await exists(jsonFile)) {
    buf = await readFile(jsonFile);
  } else {
    const {stdout, stderr} = await exec(`terraform output -json`);
    if (stderr) {
      throw `${stderr}`;
    }
    await createFile(`terraform.json`, stdout);
    buf = stdout;
  }
  return JSON.parse(String(buf));
};

const main = async (progname, args) => {
  const initHint = () => {
    const adir = process.cwd();
    console.error(`\

NOTE: to manage the ${adir} setup directory, do
  export AG_SETUP_COSMOS_BACKEND=${adir}
or
  cd ${adir}
and run ${progname} subcommands`);
  };
  const help = () => console.log(`\
Usage: ${progname} [command] [...args]

Notable commands:

bootstrap        automatic setup (idempotent)
destroy          unprovision a setup, so that it can be bootstrapped again
help             display this message
init             initialize a chain setup directory
provision        create network nodes to match this setup
run              run a shell command on a set of nodes
play             run an Ansible playbook on the nodes
rolling-restart  restart each node one at a time
show-config      display the client connection parameters
`);
  const inited = async (cmd = `${progname} init`, ...files) => {
    files = [...files, 'ag-chain-cosmos-network.txt'];
    try {
      const ps = files.map((path) => stat(path));
      await Promise.all(ps);
    } catch (e) {
      throw `${process.cwd()} does not appear to be a directory created by \`${cmd}'`;
    }
  };
  
  const cmd = args[0];
  if (CHAIN_HOME) {
    // Switch to the chain home.
    switch (cmd) {
      case 'bootstrap':
      case 'init':
      case 'destroy':
      case 'show-genesis':
      case 'show-config':
        break;
      default:
        if (process.cwd() !== CHAIN_HOME) {
          await chdir(CHAIN_HOME);
        }
        break;
    }
  }

  switch (cmd) {
    case 'help': {
      help();
      break;
    }
    case 'bootstrap': {
      let [bootAddress] = args.slice(1);
      const bootTokens = DEFAULT_BOOT_TOKENS;
      const reMain = (args) => {
        const displayArgs = [progname, ...args];
        if (displayArgs.length >= 4 && displayArgs[1] === 'new-account') {
          displayArgs[3] = '*redacted*';
        }
        console.error('$', ...displayArgs.map(shellEscape));
        return main(progname, args);
      };

      const dir = CHAIN_HOME;
      if (await exists(`${dir}/ag-chain-cosmos-network.txt`)) {
        // Change to directory.
        await chdir(dir);
      } else {
        // NOTE: init automatically changes directory.
        await reMain(['init', dir, ...(process.env.CHAIN_NAME ? [process.env.CHAIN_NAME] : [])]);
      }

      const addressFile = `account-address.txt`;
      if (bootAddress) {
        await createFile(addressFile, bootAddress);
      } else if (await exists(addressFile)) {
        bootAddress = String(await readFile(addressFile));
      } else {
        const json = await readFile(ACCOUNT_JSON);
        const {user, password} = JSON.parse(String(json));
        await reMain(['new-account', user, password]);
        const {stdout, stderr} = await exec(`ag-cosmos-helper keys show ${shellEscape(user)} -a`);
        if (stderr) {
          console.error(String(stderr));
          return 1;
        }
        bootAddress = String(stdout).trimRight();
        const {CONFIRM} = await prompt([{type: "confirm", name: "CONFIRM", default: false, message: "Have you written the phrase down in a safe place?"}]);
        if (!CONFIRM) {
          throw `You are not responsible enough to run an Agoric Cosmos Chain!`;
        }
        await createFile(addressFile, address);
      }
  
      const hostsFile = `hosts`;
      if (!await exists(hostsFile)) {
        await reMain(['provision', '-auto-approve']);
        const {stdout, stderr} = await exec(`${shellEscape(progname)} show-hosts`);
        if (stderr) {
          console.error(String(stderr));
          return 1;
        }
        const hosts = String(stdout);
        await createFile(hostsFile, hosts);
      }

      const knownHostsStamp = `ssh_known_hosts.stamp`;
      if (!await exists(knownHostsStamp)) {
        while (true) {
          const code = await reMain(['play', 'update_known_hosts']);
          if (code === 0) {
            break;
          } else if (code !== 2) {
            return code;
          }
          await sleep(10, 'for hosts to boot SSH');
        }
        await createFile(knownHostsStamp, String(new Date));
      }
      const genesisFile = `genesis.json`;
      if (!await exists(genesisFile)) {
        await reMain(['play', 'bootstrap', `-eBOOTSTRAP_ADDRESS=${bootAddress}`, `-eBOOTSTRAP_TOKENS=${bootTokens}`]);
        const {stdout, stderr} = await exec(`${shellEscape(progname)} show-genesis genesis/*/genesis.json`);
        if (stderr) {
          console.error(String(stderr));
          return 1;
        }
        await createFile(genesisFile, String(stdout));
      }

      const installGenesisStamp = `genesis.stamp`;
      if (!await exists(installGenesisStamp)) {
        await reMain(['play', 'install-genesis']);
        await createFile(installGenesisStamp, String(new Date));
      }

      const peersFile = `peers.txt`;
      let peers;
      if (await exists(peersFile)) {
        peers = await readFile(peersFile);
      } else {
        const {stdout, stderr} = await exec(`${progname} show-peers`);
        if (stderr) {
          console.error(String(stderr));
          return 1;
        }
        peers = String(stdout);
        await createFile(peersFile, peers);
      }

      const installPeersStamp = `peers.stamp`;
      if (!await exists(installPeersStamp)) {
        await reMain(['play', 'install', `-ePERSISTENT_PEERS=${peers}`]);
        await createFile(installPeersStamp, String(new Date));
      }

      const startStamp = `start.stamp`;
      if (await exists(startStamp)) {
        // Need to restart.
        await reMain(['rolling-restart']);
      } else {
        await reMain(['play', 'start']);
        await reMain(['wait-for-any']);
        await createFile(startStamp, String(new Date));
      }

      console.error(chalk.black.bgGreenBright.bold('Your Agoric Cosmos chain is now running!'));

      {
        const {stdout, stderr} = await exec(`${progname} show-config`);
        if (stderr) {
          console.error(String(stderr));
        }
        process.stdout.write(chalk.yellow(String(stdout)));
      }
      initHint();
      break;
    }

    case 'show-chain-name': {
      await inited();
      const chainName = await readFile(`ag-chain-cosmos-network.txt`);
      process.stdout.write(chainName);
      break;
    }

    case 'show-bootstrap-address': {
      await inited();
      const bootAddress = await readFile(`account-address.txt`);
      process.stdout.write(bootAddress);
      break;
    }

    case 'show-config': {
      const reMain = (args) => main(progname, args);
      setSilent(true);
      await chdir(CHAIN_HOME);
      await inited();
      process.stdout.write('CHAIN_NAME=');
      await reMain(['show-chain-name']);
      process.stdout.write('\nGCI=');
      await reMain(['show-gci']);
      process.stdout.write('\nRPCADDRS=');
      await reMain(['show-rpcaddrs']);
      process.stdout.write('\nBOOTSTRAP_ADDRESS=');
      await reMain(['show-bootstrap-address']);
      process.stdout.write('\n');
      break;
    }

    case 'rolling-restart': {
      let [...hosts] = args.slice(1);
      await inited();

      if (hosts.length === 0) {
        hosts = ['all'];
      }

      // Expand the hosts into nodes.
      const nodeMap = {};
      for (const host of hosts) {
        const {stdout, stderr} = await exec(`ansible --list-hosts ${shellEscape(host)}`);
        if (stderr) {
          console.error(String(stderr));
          return 1;
        }


        for (const line of String(stdout).split('\n')) {
          const match = line.match(/^\s*(node\d+)/);
          if (match) {
            nodeMap[match[1]] = true;
          }
        }
      }

      const nodes = Object.keys(nodeMap).sort();
      if (nodes.length === 0) {
        throw `Need at least one node`;
      }

      for (const node of nodes) {
        const nodePlaybook = (book, ...args) => playbook(book, '-l', node, ...args);
        await needDoRun(nodePlaybook('restart'));
        await needDoRun([progname, 'wait-for-any', node]);
      }
      break;
    }

    case 'wait-for-any': {
      let [host] = args.slice(1);
      await inited();
      if (!host) {
        host = 'all';
      }

      // Detect when blocks are being produced.
      let height = 0;
      while (true) {
        await sleep(6, `to check if ${chalk.underline(host)} has committed a block`);
        let buf = '';
        await needDoRun(playbook('status', '-l', host), undefined, function(chunk) {
          process.stdout.write(chunk);
          buf += String(chunk);
        });
        const match = buf.match(/Committed state.*module=state.*height=([1-9]\d*)/);
        if (match) {
          height = match[1];
          break;
        }
      }

      const atLeast = host.match(/^node\d+/) ? '' : `At least one of `;
      console.error(chalk.greenBright(`${atLeast}${chalk.underline(host)} is up-and-running (committed block height=${height})`));
      break;
    }

    case 'new-account': {
      const [user, passwd] = args.slice(1);
      const stdin = passwd ? streamFromString(`${passwd}\n${passwd}\n`) : 'inherit';
      await needDoRun(['ag-cosmos-helper', 'keys', 'add', user], stdin);
      break;
    }

    case 'show-rpcaddrs': {
      await inited();
      const prov = await provisionOutput();

      let rpcaddrs = '', sep = '';
      for (const CLUSTER of Object.keys(prov.public_ips.value)) {
        const ips = prov.public_ips.value[CLUSTER];
        const PORT = 26657;
        for (const IP of ips) {
          rpcaddrs += `${sep}${IP}:${PORT}`;
          sep = ',';
        }
      }

      process.stdout.write(rpcaddrs);
      break;
    }

    case 'show-peers': {
      await inited();
      const prov = await provisionOutput();
      const public_ips = [], public_ports = [];
      for (const CLUSTER of Object.keys(prov.public_ips.value)) {
        const ips = prov.public_ips.value[CLUSTER];
        const offset = Number(prov.offsets.value[CLUSTER]);
        for (let i = 0; i < ips.length; i ++) {
          public_ips[offset + i] = ips[i];
        }
      }

      const DEFAULT_PORT = 26656;

      let peers = '', sep = '';
      let idPath;
      let i = 0;
      while (true) {
        // Read the node-id file for this node.
        idPath = `genesis/node${i}/node-id`;
        if (!await exists(idPath)) {
          break;
        }

        const raw = await readFile(idPath);
        const ID = String(raw);

        if (!ID) {
          throw `${idPath} does not contain a node ID`;
        }
        if (!ID.match(/^[a-f0-9]+/)) {
          throw `${idPath} contains an invalid ID ${ID}`;
        }
        const IP = public_ips[i];
        if (!IP) {
          throw `${idPath} does not correspond to a Terraform public IP`;
        }
        const PORT = public_ports[i] || DEFAULT_PORT;
        peers += `${sep}${ID}@${IP}:${PORT}`;
        sep = ',';
        i ++;
      }
      if (i === 0) {
        throw `No ${idPath} file found`;
      }
      process.stdout.write(peers);
      break;
    }

    case 'show-gci': {
      const genesis = await readFile('genesis.json');
      const s = djsonStringify(JSON.parse(String(genesis)));
      const gci = createHash('sha256').update(s).digest('hex');
      process.stdout.write(gci);
      break;
    }

    case 'show-genesis': {
      const files = args.slice(1);
      const ps = files.map((file) => readFile(file));
      const bodies = await Promise.all(ps);
      let first;
      const validators = [];
      for (const body of bodies) {
        const text = String(body);
        const obj = JSON.parse(text);
        if (!first) {
          first = obj;
        }
        validators.push(...obj.validators);
      }
      first.validators = validators;
      process.stdout.write(JSON.stringify(first, undefined, 2));
      break;
    }

    case 'destroy': {
      let [dir] = args.slice(1);
      if (!dir) {
        dir = CHAIN_HOME;
      }
      if (!dir) {
        throw `Need: [dir]`;
      }

      // Unprovision terraform.
      await chdir(dir);

      if (await exists(`.terraform`)) {
        // Terraform will prompt.
        await needDoRun(['terraform', 'destroy']);
      } else {
        const {CONFIRM} = await prompt([{type: 'input', name: 'CONFIRM', default: 'no', message: `Type "yes" if you are sure you want to reset ${dir} state:`}]);
        if (CONFIRM !== 'yes') {
          throw `Aborting due to user request`;
        }
      }

      // Unlink all the state that was built up after terraforming.
      await Promise.all(AFTER_TERRAFORMING.map((name) => unlink(name).catch(e => {})));

      // Remove the genesis directory and all stamps.
      await needDoRun(['rm', '-rf', 'genesis']);
      await needDoRun(['sh', '-c', 'rm -f *.stamp']);
      break;
    }

    case 'init': {
      await doInit(progname, args);
      initHint();
      break;
    }

    case 'provision': {
      await inited();
      if (!await exists('.terraform')) {
        await needDoRun(['terraform', 'init']);
      }
      await needDoRun(['terraform', 'apply', ...args.slice(1)]);
      break;
    }

    case 'show-hosts': {
      const SSH_PRIVATE_KEY_FILE = resolve(process.cwd(), `id_${SSH_TYPE}`);
      await inited(`${progname} init`, SSH_PRIVATE_KEY_FILE);
      const prov = await provisionOutput();
      const out = process.stdout;
      out.write(`\
all:
  children:
`);
      let allHosts = `\
  hosts:
`;
      for (const provider of Object.keys(prov.public_ips.value).sort()) {
        out.write(`\
    ${provider}:
      hosts:
`)
        const ips = prov.public_ips.value[provider];
        const offset = Number(prov.offsets.value[provider]);
        for (let instance = 0; instance < ips.length; instance ++) {
          const ip = ips[instance];
          const node = `node${offset + instance}`
          const host = `\
${node}:
  ansible_host: ${ip}
  ansible_ssh_user: root
  ansible_ssh_private_key_file: '${SSH_PRIVATE_KEY_FILE}'
  ansible_python_interpreter: /usr/bin/python
`;
          const prefixLines = (str, prefix) => {
            const allLines = str.split('\n');
            if (allLines[allLines.length - 1] === '') {
              allLines.pop();
            }
            return allLines.reduce((prior, line) => (prior + prefix + line + '\n'), '');
          };
          const indent = (str, nspaces) => prefixLines(str, ' '.repeat(nspaces));
          allHosts += indent(host, 4);
          out.write(indent(host, 8));
        }
      }
      out.write(allHosts);
      break;
    }

    case 'play': {
      const [pb, ...pbargs] = args.slice(1);
      if (!pb) {
        throw `Need: [playbook name]`;
      }
      if (!pb.match(/^\w[-\w]*$/)) {
        throw `[playbook] ${JSON.stringify(pb)} must be a word`;
      }
      await inited();
      return await doRun(playbook(pb, ...pbargs));
    }

    case 'run': {
      const [host, ...cmd] = args.slice(1);
      if (!host || cmd.length === 0) {
        throw `Need: [host] [cmd...]`;
      }
      await inited();
      let runArg;
      if (cmd.length === 1) {
        if (cmd[0].match(shellMetaRegexp)) {
          // Already contains metacharacters.
          runArg = `sh -c ${shellEscape(cmd[0])}`;
        } else {
          runArg = cmd[0];
        }
      } else {
        // Need to escape each argument individually.
        const escapedArgs = cmd.map(shellEscape);
        runArg = `sh -c ${shellEscape(escapedArgs.join(' '))}`;
      }
      const run = ['ansible', '-f10', host, '-a', runArg];
      await needDoRun(run);
      break;
    }

    default:
      throw `Unknown command ${cmd}; try \`${progname} help'`;
  }
  return 0;
};

export default main;
