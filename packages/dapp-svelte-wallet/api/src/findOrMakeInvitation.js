import { assert, details, q } from '@agoric/assert';
import { E } from '@agoric/eventual-send';
import { passStyleOf } from '@agoric/marshal';

export const makeId = (dappOrigin, rawId) => `${dappOrigin}#${rawId}`;

const assertFirstCapASCII = str => {
  assert.typeof(str, 'string');
  const firstCapASCII = /^[A-Z][a-zA-Z0-9_$]*$/;
  assert(
    firstCapASCII.test(str),
    details`The string ${q(
      str,
    )} must be ascii and must start with a capital letter.`,
  );
  assert(
    str !== 'NaN' && str !== 'Infinity',
    details`keyword ${q(str)} must not be a number's name`,
  );
};

/**
 * @param {Amount} invitationPurseBalance
 * @param {Object} query
 * @param {Board} query.board
 * @param {string} query.boardId
 * @returns {Array}
 * @deprecated
 */
const findByBoardId = async (invitationPurseBalance, { board, boardId }) => {
  assert.typeof(boardId, 'string');
  const invitationHandle = await E(board).getValue(boardId);
  const match = element => element.handle === invitationHandle;
  const matchingValue = invitationPurseBalance.value.find(match);
  assert(
    matchingValue,
    details`Cannot find invitation corresponding to ${q(boardId)}`,
  );

  return harden([matchingValue]);
};

// An invitation matching the query parameters is already expected
// to be deposited in the default Zoe invitation purse
/**
 * @param {Amount} invitationPurseBalance
 * @param {Record<string, any>} kvs
 */
const findByKeyValuePairs = async (invitationPurseBalance, kvs) => {
  // TODO: use an AmountMath method instead to improve efficiency

  // For every key and value in `query`, return an amount
  // with any matches for those exact keys and values. Keys not in
  // `query` count as a match
  const matches = invitationDetail =>
    Object.entries(kvs).every(
      ([key, value]) => invitationDetail[key] === value,
    );

  const matchingValue = invitationPurseBalance.value.find(matches);
  assert(
    matchingValue,
    details`Cannot find invitation corresponding to ${q(kvs)}`,
  );
  return harden([matchingValue]);
};

const makeFindInvitation = (invitationPurse, invitationMath) => {
  const findInvitation = async (queryFn, queryParams) => {
    const purseBalance = await E(invitationPurse).getCurrentAmount();
    const value = await queryFn(purseBalance, queryParams);
    const invitationAmount = invitationMath.make(value);
    const invitationP = E(invitationPurse).withdraw(invitationAmount);
    return invitationP;
  };
  return findInvitation;
};

const makeContinuingInvitation = async (
  idToOfferResultPromiseKit,
  dappOrigin,
  { priorOfferId: rawPriorOfferId, description },
) => {
  assertFirstCapASCII(description);

  const priorOfferId = makeId(dappOrigin, rawPriorOfferId);
  const offerResult = await idToOfferResultPromiseKit.get(priorOfferId).promise;
  assert(
    passStyleOf(offerResult) === 'copyRecord',
    `offerResult must be a record to have an invitationMakers property`,
  );
  assert(
    offerResult.invitationMakers,
    `offerResult does not have an invitationMakers property`,
  );

  const invitationP = E(offerResult.invitationMakers)[description]();
  return invitationP;
};

export const findOrMakeInvitation = async (
  idToOfferResultPromiseKit,
  board,
  invitationPurse,
  invitationMath,
  offer,
) => {
  if (offer.invitation) {
    // The invitation is directly specified.
    return offer.invitation;
  }

  const findInvitation = makeFindInvitation(invitationPurse, invitationMath);

  // Deprecated
  if (offer.inviteHandleBoardId) {
    const queryParams = {
      board,
      boardId: offer.inviteHandleBoardId,
    };
    return findInvitation(findByBoardId, queryParams);
  }

  // Deprecated
  if (offer.invitationHandleBoardId) {
    const queryParams = {
      board,
      boardId: offer.invitationHandleBoardId,
    };
    return findInvitation(findByBoardId, queryParams);
  }

  if (offer.invitationQuery) {
    return findInvitation(findByKeyValuePairs, offer.invitationQuery);
  }

  if (offer.continuingInvitation) {
    const dappOrigin =
      offer.requestContext && offer.requestContext.dappOrigin
        ? offer.requestContext.dappOrigin
        : `unknown`;
    return makeContinuingInvitation(
      idToOfferResultPromiseKit,
      dappOrigin,
      offer.continuingInvitation,
    );
  }

  throw Error(`no invitation was found or made for this offer ${offer.id}`);
};
