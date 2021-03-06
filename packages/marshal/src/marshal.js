// @ts-check

// eslint-disable-next-line spaced-comment
/// <reference types="ses"/>

import Nat from '@agoric/nat';
import { assert, details as d, q } from '@agoric/assert';
import { isPromise } from '@agoric/promise-kit';

import './types';

// TODO: Use just 'remote' when we're willing to make a breaking change.
export const REMOTE_STYLE = 'presence';

// TODO, remove the mustPassByPresence alias when we make a breaking change.
// eslint-disable-next-line no-use-before-define
export { mustPassByRemote as mustPassByPresence };

/**
 * @type {WeakMap<Object, InterfaceSpec>}
 */
const remotableToInterface = new WeakMap();

/** @type {MarshalGetInterfaceOf} */
export function getInterfaceOf(maybeRemotable) {
  return remotableToInterface.get(maybeRemotable);
}

/**
 * Do a deep copy of the object, handling Proxies and recursion.
 * The resulting copy is guaranteed to be pure data, as well as hardened.
 * Such a hardened, pure copy cannot be used as a communications path.
 *
 * @template T
 * @param {T & OnlyData} val input value.  NOTE: Must be hardened!
 * @param {WeakMap<any,any>} [already=new WeakMap()]
 * @returns {T & PureData} pure, hardened copy
 */
function pureCopy(val, already = new WeakMap()) {
  // eslint-disable-next-line no-use-before-define
  const passStyle = passStyleOf(val);
  switch (passStyle) {
    case 'bigint':
    case 'boolean':
    case 'null':
    case 'number':
    case 'string':
    case 'undefined':
    case 'symbol':
      return val;

    case 'copyArray':
    case 'copyRecord': {
      const obj = /** @type {Object} */ (val);
      if (already.has(obj)) {
        return already.get(obj);
      }

      // Create a new identity.
      const copy = /** @type {T} */ (passStyle === 'copyArray' ? [] : {});

      // Prevent recursion.
      already.set(obj, copy);

      // Make a deep copy on the new identity.
      // Object.entries(obj) takes a snapshot (even if a Proxy).
      Object.entries(obj).forEach(([prop, value]) => {
        copy[prop] = pureCopy(value, already);
      });
      return harden(copy);
    }

    case 'copyError': {
      const unk = /** @type {unknown} */ (val);
      const err = /** @type {Error} */ (unk);

      if (already.has(err)) {
        return already.get(err);
      }

      const { name, message } = err;

      // eslint-disable-next-line no-use-before-define
      const EC = getErrorConstructor(`${name}`) || Error;
      const copy = harden(new EC(`${message}`));
      already.set(err, copy);

      const unk2 = /** @type {unknown} */ (harden(copy));
      return /** @type {T} */ (unk2);
    }

    case REMOTE_STYLE: {
      throw TypeError(
        `Input value ${passStyle} cannot be copied as it must be passed by reference`,
      );
    }

    case 'promise': {
      throw TypeError(`Promises cannot be copied`);
    }

    default:
      throw TypeError(`Input value ${passStyle} is not recognized as data`);
  }
}
harden(pureCopy);
export { pureCopy };

/**
 * Special property name that indicates an encoding that needs special
 * decoding.
 */
const QCLASS = '@qclass';
export { QCLASS };

const errorConstructors = new Map([
  ['Error', Error],
  ['EvalError', EvalError],
  ['RangeError', RangeError],
  ['ReferenceError', ReferenceError],
  ['SyntaxError', SyntaxError],
  ['TypeError', TypeError],
  ['URIError', URIError],
]);

export function getErrorConstructor(name) {
  return errorConstructors.get(name);
}

/**
 * @param {Passable} val
 * @returns {boolean}
 */
function isPassByCopyError(val) {
  // TODO: Need a better test than instanceof
  if (!(val instanceof Error)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  const { name } = val;
  const EC = getErrorConstructor(name);
  if (!EC || EC.prototype !== proto) {
    throw TypeError(
      `Errors must inherit from an error class .prototype ${val}`,
    );
  }

  const {
    message: mDesc,
    // Allow but ignore only extraneous own `stack` property.
    stack: _optStackDesc,
    ...restDescs
  } = Object.getOwnPropertyDescriptors(val);
  const restNames = Object.keys(restDescs);
  if (restNames.length >= 1) {
    throw new TypeError(`Unexpected own properties in error: ${restNames}`);
  }
  if (mDesc) {
    if (typeof mDesc.value !== 'string') {
      throw new TypeError(`Malformed error object: ${val}`);
    }
    if (mDesc.enumerable) {
      throw new TypeError(`An error's .message must not be enumerable`);
    }
  }
  return true;
}

/**
 * @param {Passable} val
 * @returns {boolean}
 */
function isPassByCopyArray(val) {
  if (!Array.isArray(val)) {
    return false;
  }
  if (Object.getPrototypeOf(val) !== Array.prototype) {
    throw new TypeError(`Malformed array: ${val}`);
  }
  const len = val.length;
  const descs = Object.getOwnPropertyDescriptors(val);
  for (let i = 0; i < len; i += 1) {
    const desc = descs[i];
    if (!desc) {
      throw new TypeError(`Arrays must not contain holes: ${i}`);
    }
    if (!('value' in desc)) {
      throw new TypeError(`Arrays must not contain accessors: ${i}`);
    }
    if (typeof desc.value === 'function') {
      throw new TypeError(`Arrays must not contain methods: ${i}`);
    }
    if (!desc.enumerable) {
      throw new TypeError(`Array elements must be enumerable: ${i}`);
    }
  }
  if (Object.keys(descs).length !== len + 1) {
    throw new TypeError(`Arrays must not have non-indexes: ${val}`);
  }
  return true;
}

/**
 * @param {Passable} val
 * @returns {boolean}
 */
function isPassByCopyRecord(val) {
  if (Object.getPrototypeOf(val) !== Object.prototype) {
    return false;
  }
  const descEntries = Object.entries(Object.getOwnPropertyDescriptors(val));
  if (descEntries.length === 0) {
    // empty non-array objects are pass-by-remote, not pass-by-copy
    return false;
  }
  for (const [_key, desc] of descEntries) {
    if (typeof desc.value === 'function') {
      return false;
    }
  }
  for (const [key, desc] of descEntries) {
    if (typeof key === 'symbol') {
      throw new TypeError(
        `Records must not have symbol-named properties: ${String(key)}`,
      );
    }
    if (!('value' in desc)) {
      throw new TypeError(`Records must not contain accessors: ${key}`);
    }
    if (!desc.enumerable) {
      throw new TypeError(`Record fields must be enumerable: ${key}`);
    }
  }
  return true;
}

/**
 * Ensure that val could become a legitimate remotable.  This is used
 * internally both in the construction of a new remotable and
 * mustPassByRemote.
 *
 * @param {*} val The remotable candidate to check
 */
function assertCanBeRemotable(val) {
  // throws exception if cannot
  if (typeof val !== 'object') {
    throw new Error(`cannot serialize non-objects like ${val}`);
  }
  if (Array.isArray(val)) {
    throw new Error(`Arrays cannot be pass-by-remote`);
  }
  if (val === null) {
    throw new Error(`null cannot be pass-by-remote`);
  }

  const names = Object.getOwnPropertyNames(val);
  names.forEach(name => {
    if (typeof val[name] !== 'function') {
      throw new Error(
        `cannot serialize objects with non-methods like the .${name} in ${val}`,
      );
      // return false;
    }
  });

  // ok!
}

/**
 * @param {Remotable} val
 */
export function mustPassByRemote(val) {
  if (!Object.isFrozen(val)) {
    throw new Error(`cannot serialize non-frozen objects like ${val}`);
  }

  if (getInterfaceOf(val) === undefined) {
    // Not a registered Remotable, so check its contents.
    assertCanBeRemotable(val);
  }

  // It's not a registered Remotable, so enforce the prototype check.
  const p = Object.getPrototypeOf(val);
  if (p !== null && p !== Object.prototype) {
    mustPassByRemote(p);
  }
}

/**
 * This is the equality comparison used by JavaScript's Map and Set
 * abstractions, where NaN is the same as NaN and -0 is the same as
 * 0. Marshal serializes -0 as zero, so the semantics of our distributed
 * object system does not distinguish 0 from -0.
 *
 * `sameValueZero` is the EcmaScript spec name for this equality comparison,
 * but TODO we need a better name for the API.
 *
 * @param {any} x
 * @param {any} y
 * @returns {boolean}
 */
export function sameValueZero(x, y) {
  return x === y || Object.is(x, y);
}

/**
 * objects can only be passed in one of two/three forms:
 * 1: pass-by-remote: all properties (own and inherited) are methods,
 *    the object itself is of type object, not function
 * 2: pass-by-copy: all string-named own properties are data, not methods
 *    the object must inherit from Object.prototype or null
 * 3: the empty object is pass-by-remote, for identity comparison
 *
 * all objects must be frozen
 *
 * anything else will throw an error if you try to serialize it
 * with these restrictions, our remote call/copy protocols expose all useful
 * behavior of these objects: pass-by-remote objects have no other data (so
 * there's nothing else to copy), and pass-by-copy objects have no other
 * behavior (so there's nothing else to invoke)
 *
 * How would val be passed?  For primitive values, the answer is
 *   * 'null' for null
 *   * throwing an error for a symbol, whether registered or not.
 *   * that value's typeof string for all other primitive values
 * For frozen objects, the possible answers
 *   * 'copyRecord' for non-empty records with only data properties
 *   * 'copyArray' for arrays with only data properties
 *   * 'copyError' for instances of Error with only data properties
 *   * REMOTE_STYLE for non-array objects with only method properties
 *   * 'promise' for genuine promises only
 *   * throwing an error on anything else, including thenables.
 * We export passStyleOf so other algorithms can use this module's
 * classification.
 *
 * @param {Passable} val
 * @returns {PassStyle}
 */
export function passStyleOf(val) {
  const typestr = typeof val;
  switch (typestr) {
    case 'object': {
      if (getInterfaceOf(val)) {
        return REMOTE_STYLE;
      }
      if (val === null) {
        return 'null';
      }
      if (QCLASS in val) {
        // TODO Hilbert hotel
        throw new Error(`property "${QCLASS}" reserved`);
      }
      if (!Object.isFrozen(val)) {
        throw new Error(
          `Cannot pass non-frozen objects like ${val}. Use harden()`,
        );
      }
      if (isPromise(val)) {
        return 'promise';
      }
      if (typeof val.then === 'function') {
        throw new Error(`Cannot pass non-promise thenables`);
      }
      if (isPassByCopyError(val)) {
        return 'copyError';
      }
      if (isPassByCopyArray(val)) {
        return 'copyArray';
      }
      if (isPassByCopyRecord(val)) {
        return 'copyRecord';
      }
      mustPassByRemote(val);
      return REMOTE_STYLE;
    }
    case 'function': {
      throw new Error(`Bare functions like ${val} are disabled for now`);
    }
    case 'undefined':
    case 'string':
    case 'boolean':
    case 'number':
    case 'bigint':
    case 'symbol': {
      return typestr;
    }
    default: {
      throw new TypeError(`Unrecognized typeof ${typestr}`);
    }
  }
}

/**
 * The ibid logic relies on
 *    * JSON.stringify on an array visiting array indexes from 0 to
 *      arr.length -1 in order, and not visiting anything else.
 *    * JSON.parse of a record (a plain object) creating an object on
 *      which a getOwnPropertyNames will enumerate properties in the
 *      same order in which they appeared in the parsed JSON string.
 */
function makeReplacerIbidTable() {
  const ibidMap = new Map();
  let ibidCount = 0;

  return harden({
    has(obj) {
      return ibidMap.has(obj);
    },
    get(obj) {
      return ibidMap.get(obj);
    },
    add(obj) {
      ibidMap.set(obj, ibidCount);
      ibidCount += 1;
    },
  });
}

function makeReviverIbidTable(cyclePolicy) {
  const ibids = [];
  const unfinishedIbids = new WeakSet();

  return harden({
    get(allegedIndex) {
      const index = Nat(allegedIndex);
      if (index >= ibids.length) {
        throw new RangeError(`ibid out of range: ${index}`);
      }
      const result = ibids[index];
      if (unfinishedIbids.has(result)) {
        switch (cyclePolicy) {
          case 'allowCycles': {
            break;
          }
          case 'warnOfCycles': {
            console.log(`Warning: ibid cycle at ${index}`);
            break;
          }
          case 'forbidCycles': {
            throw new TypeError(`Ibid cycle at ${index}`);
          }
          default: {
            throw new TypeError(`Unrecognized cycle policy: ${cyclePolicy}`);
          }
        }
      }
      return result;
    },
    register(obj) {
      ibids.push(obj);
      return obj;
    },
    start(obj) {
      ibids.push(obj);
      unfinishedIbids.add(obj);
      return obj;
    },
    finish(obj) {
      unfinishedIbids.delete(obj);
      return obj;
    },
  });
}

/**
 * @template Slot
 * @type {ConvertValToSlot<Slot>}
 */
const defaultValToSlotFn = x => x;
/**
 * @template Slot
 * @type {ConvertSlotToVal<Slot>}
 */
const defaultSlotToValFn = (x, _) => x;

/**
 * @template Slot
 * @type {MakeMarshal<Slot>}
 */
export function makeMarshal(
  convertValToSlot = defaultValToSlotFn,
  convertSlotToVal = defaultSlotToValFn,
  { marshalName = 'anon-marshal' } = {},
) {
  assert.typeof(marshalName, 'string');
  // Ascending numbers identifying the sending of errors relative to this
  // marshal instance.
  let errorCount = 0;
  const nextErrorId = () => {
    errorCount += 1;
    return `error:${marshalName}#${errorCount}`;
  };

  /**
   * @template Slot
   * @param {Passable} val
   * @param {Slot[]} slots
   * @param {WeakMap<Passable,number>} slotMap
   * @param {InterfaceSpec=} iface
   * @returns {Encoding}
   */
  function serializeSlot(val, slots, slotMap, iface = undefined) {
    let slotIndex;
    if (slotMap.has(val)) {
      slotIndex = slotMap.get(val);
    } else {
      const slot = convertValToSlot(val);

      slotIndex = slots.length;
      slots.push(slot);
      slotMap.set(val, slotIndex);
    }

    /*
    if (iface === undefined && passStyleOf(val) === REMOTE_STYLE) {
      // iface = `Alleged: remotable at slot ${slotIndex}`;
      if (
        Object.getPrototypeOf(val) === Object.prototype &&
        Object.getOwnPropertyNames(val).length === 0
      ) {
        // For now, skip the diagnostic if we have a pure empty object
      } else {
        try {
          assert.fail(d`Serialize ${val} generates needs iface`);
        } catch (err) {
          console.info(err);
        }
      }
    }
    */

    if (iface === undefined) {
      return harden({
        [QCLASS]: 'slot',
        index: slotIndex,
      });
    }
    return harden({
      [QCLASS]: 'slot',
      iface,
      index: slotIndex,
    });
  }

  /**
   * @template Slot
   * @type {Serialize<Slot>}
   */
  const serialize = root => {
    const slots = [];
    // maps val (promise or remotable) to index of slots[]
    const slotMap = new Map();
    const ibidTable = makeReplacerIbidTable();

    /**
     * Just consists of data that rounds trips to plain data.
     *
     * @typedef {any} PlainJSONData
     */

    /**
     * Must encode `val` into plain JSON data *canonically*, such that
     * `sameStructure(v1, v2)` implies
     * `JSON.stringify(encode(v1)) === JSON.stringify(encode(v2))`
     * For each record, we only accept sortable property names
     * (no anonymous symbols) and on the encoded form. The sort
     * order of these names must be the same as their enumeration
     * order, so a `JSON.stringify` of the encoded form agrees with
     * a canonical-json stringify of the encoded form.
     *
     * @param {Passable} val
     * @returns {PlainJSONData}
     */
    const encode = val => {
      // First we handle all primitives. Some can be represented directly as
      // JSON, and some must be encoded as [QCLASS] composites.
      const passStyle = passStyleOf(val);
      switch (passStyle) {
        case 'null': {
          return null;
        }
        case 'undefined': {
          return harden({ [QCLASS]: 'undefined' });
        }
        case 'string':
        case 'boolean': {
          return val;
        }
        case 'number': {
          if (Number.isNaN(val)) {
            return harden({ [QCLASS]: 'NaN' });
          }
          if (Object.is(val, -0)) {
            return 0;
          }
          if (val === Infinity) {
            return harden({ [QCLASS]: 'Infinity' });
          }
          if (val === -Infinity) {
            return harden({ [QCLASS]: '-Infinity' });
          }
          return val;
        }
        case 'bigint': {
          return harden({
            [QCLASS]: 'bigint',
            digits: String(val),
          });
        }
        case 'symbol': {
          switch (val) {
            case Symbol.asyncIterator: {
              return harden({
                [QCLASS]: '@@asyncIterator',
              });
            }
            default: {
              throw assert.fail(d`Unsupported symbol ${q(String(val))}`);
            }
          }
        }
        default: {
          // if we've seen this object before, serialize a backref
          if (ibidTable.has(val)) {
            // Backreference to prior occurrence
            return harden({
              [QCLASS]: 'ibid',
              index: ibidTable.get(val),
            });
          }
          ibidTable.add(val);

          switch (passStyle) {
            case 'copyRecord': {
              // Currently copyRecord allows only string keys so this will
              // work. If we allow sortable symbol keys, this will need to
              // become more interesting.
              const names = Reflect.ownKeys(val).sort();
              return Object.fromEntries(
                names.map(name => [name, encode(val[name])]),
              );
            }
            case 'copyArray': {
              return val.map(encode);
            }
            case 'copyError': {
              // We deliberately do not share the stack, but it would
              // be useful to log the stack locally so someone who has
              // privileged access to the throwing Vat can correlate
              // the problem with the remote Vat that gets this
              // summary. If we do that, we could allocate some random
              // identifier and include it in the message, to help
              // with the correlation.

              const errorId = nextErrorId();
              assert.note(val, d`Sent as ${errorId}`);
              // TODO we need to instead log to somewhere hidden
              // to be revealed when correlating with the received error.
              // By sending this to `console.log`, under swingset this is
              // enabled by `agoric start --reset -v` and not enabled without
              // the `-v` flag.
              console.log('Temporary logging of sent error', val);
              return harden({
                [QCLASS]: 'error',
                errorId,
                message: `${val.message}`,
                name: `${val.name}`,
              });
            }
            case REMOTE_STYLE: {
              const iface = getInterfaceOf(val);
              // console.log(`serializeSlot: ${val}`);
              return serializeSlot(val, slots, slotMap, iface);
            }
            case 'promise': {
              // console.log(`serializeSlot: ${val}`);
              return serializeSlot(val, slots, slotMap);
            }
            default: {
              throw new TypeError(`unrecognized passStyle ${passStyle}`);
            }
          }
        }
      }
    };

    const encoded = encode(root);

    return harden({
      body: JSON.stringify(encoded),
      slots,
    });
  };

  function makeFullRevive(slots, cyclePolicy) {
    // ibid table is shared across recursive calls to fullRevive.
    const ibidTable = makeReviverIbidTable(cyclePolicy);

    // We stay close to the algorithm at
    // https://tc39.github.io/ecma262/#sec-json.parse , where
    // fullRevive(JSON.parse(str)) is like JSON.parse(str, revive))
    // for a similar reviver. But with the following differences:
    //
    // Rather than pass a reviver to JSON.parse, we first call a plain
    // (one argument) JSON.parse to get rawTree, and then post-process
    // the rawTree with fullRevive. The kind of revive function
    // handled by JSON.parse only does one step in post-order, with
    // JSON.parse doing the recursion. By contrast, fullParse does its
    // own recursion, enabling it to interpret ibids in the same
    // pre-order in which the replacer visited them, and enabling it
    // to break cycles.
    //
    // In order to break cycles, the potentially cyclic objects are
    // not frozen during the recursion. Rather, the whole graph is
    // hardened before being returned. Error objects are not
    // potentially recursive, and so may be harmlessly hardened when
    // they are produced.
    //
    // fullRevive can produce properties whose value is undefined,
    // which a JSON.parse on a reviver cannot do. If a reviver returns
    // undefined to JSON.parse, JSON.parse will delete the property
    // instead.
    //
    // fullRevive creates and returns a new graph, rather than
    // modifying the original tree in place.
    //
    // fullRevive may rely on rawTree being the result of a plain call
    // to JSON.parse. However, it *cannot* rely on it having been
    // produced by JSON.stringify on the replacer above, i.e., it
    // cannot rely on it being a valid marshalled
    // representation. Rather, fullRevive must validate that.
    return function fullRevive(rawTree) {
      if (Object(rawTree) !== rawTree) {
        // primitives pass through
        return rawTree;
      }
      if (QCLASS in rawTree) {
        const qclass = rawTree[QCLASS];
        if (typeof qclass !== 'string') {
          throw new TypeError(`invalid qclass typeof ${typeof qclass}`);
        }
        switch (qclass) {
          // Encoding of primitives not handled by JSON
          case 'undefined': {
            return undefined;
          }
          case 'NaN': {
            return NaN;
          }
          case 'Infinity': {
            return Infinity;
          }
          case '-Infinity': {
            return -Infinity;
          }
          case 'bigint': {
            if (typeof rawTree.digits !== 'string') {
              throw new TypeError(
                `invalid digits typeof ${typeof rawTree.digits}`,
              );
            }
            /* eslint-disable-next-line no-undef */
            return BigInt(rawTree.digits);
          }
          case '@@asyncIterator': {
            return Symbol.asyncIterator;
          }

          case 'ibid': {
            return ibidTable.get(rawTree.index);
          }

          case 'error': {
            if (typeof rawTree.name !== 'string') {
              throw new TypeError(
                `invalid error name typeof ${typeof rawTree.name}`,
              );
            }
            if (typeof rawTree.message !== 'string') {
              throw new TypeError(
                `invalid error message typeof ${typeof rawTree.message}`,
              );
            }
            const EC = getErrorConstructor(`${rawTree.name}`) || Error;
            const error = harden(new EC(`${rawTree.message}`));
            ibidTable.register(error);
            if (typeof rawTree.errorId === 'string') {
              // errorId is a late addition so be tolerant of its absence.
              assert.note(error, d`Received as ${rawTree.errorId}`);
            }
            return error;
          }

          case 'slot': {
            const slot = slots[Nat(rawTree.index)];
            return ibidTable.register(convertSlotToVal(slot, rawTree.iface));
          }

          default: {
            // TODO reverse Hilbert hotel
            throw new TypeError(`unrecognized ${QCLASS} ${qclass}`);
          }
        }
      } else if (Array.isArray(rawTree)) {
        const result = ibidTable.start([]);
        const len = rawTree.length;
        for (let i = 0; i < len; i += 1) {
          result[i] = fullRevive(rawTree[i]);
        }
        return ibidTable.finish(result);
      } else {
        const result = ibidTable.start({});
        const names = Object.getOwnPropertyNames(rawTree);
        for (const name of names) {
          result[name] = fullRevive(rawTree[name]);
        }
        return ibidTable.finish(result);
      }
    };
  }

  /**
   * @template Slot
   * @type {Unserialize<Slot>}
   */
  function unserialize(data, cyclePolicy = 'forbidCycles') {
    if (data.body !== `${data.body}`) {
      throw new Error(
        `unserialize() given non-capdata (.body is ${data.body}, not string)`,
      );
    }
    if (!Array.isArray(data.slots)) {
      throw new Error(`unserialize() given non-capdata (.slots are not Array)`);
    }
    const rawTree = harden(JSON.parse(data.body));
    const fullRevive = makeFullRevive(data.slots, cyclePolicy);
    return harden(fullRevive(rawTree));
  }

  return harden({
    serialize,
    unserialize,
  });
}

/**
 * Create and register a Remotable.  After this, getInterfaceOf(remotable)
 * returns iface.
 *
 * // https://github.com/Agoric/agoric-sdk/issues/804
 *
 * @param {InterfaceSpec} [iface='Remotable'] The interface specification for
 * the remotable. For now, a string iface must be "Remotable" or begin with
 * "Alleged: ", to serve as the alleged name. More general ifaces are not yet
 * implemented. This is temporary. We include the
 * "Alleged" as a reminder that we do not yet have SwingSet or Comms Vat
 * support for ensuring this is according to the vat hosting the object.
 * Currently, Alice can tell Bob about Carol, where VatA (on Alice's behalf)
 * misrepresents Carol's `iface`. VatB and therefore Bob will then see
 * Carol's `iface` as misrepresented by VatA.
 * @param {object} [props={}] Own-properties are copied to the remotable
 * @param {object} [remotable={}] The object used as the remotable
 * @returns {object} remotable, modified for debuggability
 */
function Remotable(iface = 'Remotable', props = {}, remotable = {}) {
  // TODO unimplemented
  assert.typeof(
    iface,
    'string',
    d`Interface ${iface} must be a string; unimplemented`,
  );
  // TODO unimplemented
  assert(
    iface === 'Remotable' || iface.startsWith('Alleged: '),
    d`For now, iface ${q(
      iface,
    )} must be "Remotable" or begin with "Alleged: "; unimplemented`,
  );
  iface = pureCopy(harden(iface));

  // TODO: When iface is richer than just string, we need to get the allegedName
  // in a different way.
  const allegedName = iface;

  // Fail fast: check that the unmodified object is able to become a Remotable.
  assertCanBeRemotable(remotable);

  // Ensure that the remotable isn't already registered.
  if (remotableToInterface.has(remotable)) {
    throw Error(`Remotable ${remotable} is already mapped to an interface`);
  }

  // A prototype for debuggability.
  const oldRemotableProto = harden(Object.getPrototypeOf(remotable));

  // Fail fast: create a fresh empty object with the old
  // prototype in order to check it against our rules.
  mustPassByRemote(harden(Object.create(oldRemotableProto)));

  // Assign the arrow function to a variable to set its .name.
  const toString = () => `[${allegedName}]`;
  const remotableProto = harden(
    Object.create(oldRemotableProto, {
      toString: {
        value: toString,
      },
      [Symbol.toStringTag]: {
        value: allegedName,
      },
    }),
  );

  // Take a static copy of the properties.
  const propEntries = Object.entries(props);
  const mutateHardenAndCheck = target => {
    // Add the snapshotted properties.
    /** @type {PropertyDescriptorMap} */
    const newProps = {};
    propEntries.forEach(([prop, value]) => (newProps[prop] = { value }));
    Object.defineProperties(target, newProps);

    // Set the prototype for debuggability.
    Object.setPrototypeOf(target, remotableProto);
    harden(remotableProto);

    harden(target);
    assertCanBeRemotable(target);
    return target;
  };

  // Fail fast: check a fresh remotable to see if our rules fit.
  const throwawayRemotable = Object.create(oldRemotableProto);
  mutateHardenAndCheck(throwawayRemotable);

  // Actually finish the new remotable.
  mutateHardenAndCheck(remotable);

  // COMMITTED!
  // We're committed, so keep the interface for future reference.
  assert(iface !== undefined); // To make TypeScript happy
  remotableToInterface.set(remotable, iface);
  return remotable;
}

harden(Remotable);
export { Remotable };

/**
 * A concise convenience for the most common `Remotable` use.
 *
 * @param {string} farName This name will be prepended with `Alleged: `
 * for now to form the `Remotable` `iface` argument.
 * @param {object} [remotable={}] The object used as the remotable
 * @returns {object} remotable, modified for debuggability
 */
const Far = (farName, remotable = {}) =>
  Remotable(`Alleged: ${farName}`, undefined, remotable);

harden(Far);
export { Far };
