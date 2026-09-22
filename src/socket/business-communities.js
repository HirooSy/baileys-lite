/**
 * Business + Communities socket layers (the outermost wrappers).
 * Combines Socket/business.js and Socket/communities.js:
 *
 *   makeMessagesRecvSocket -> makeBusinessSocket -> makeCommunitiesSocket
 *
 * makeCommunitiesSocket is what index.js exports as makeWASocket.
 * (Catalog parse helpers such as parseCatalogNode live in utils/message-processing.js.)
 */
import { proto } from '../../WAProto/index.js'
import logger from '../foundation/logger.js'
import { WAMessageStubType } from '../constants.js'
import { generateMessageID, generateMessageIDV2, unixTimestampSeconds } from '../utils/wa-protocol-core.js'
import { getRawMediaUploadData } from '../utils/media.js'
import {
	parseCatalogNode,
	parseCollectionsNode,
	parseOrderDetailsNode,
	parseProductNode,
	toProductNode,
	uploadingNecessaryImagesOfProduct
} from '../utils/message-processing.js'
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	jidEncode,
	jidNormalizedUser,
	S_WHATSAPP_NET
} from '../binary/wa-binary.js'
import { makeMessagesRecvSocket } from './messages-recv.js'

export const makeBusinessSocket = (config) => {
    const sock = makeMessagesRecvSocket(config);
    const { authState, query, waUploadToServer } = sock;
    const updateBussinesProfile = async (args) => {
        const node = [];
        const simpleFields = ['address', 'email', 'description'];
        node.push(...simpleFields
            .filter(key => args[key] !== undefined && args[key] !== null)
            .map(key => ({
            tag: key,
            attrs: {},
            content: args[key]
        })));
        if (args.websites !== undefined) {
            node.push(...args.websites.map(website => ({
                tag: 'website',
                attrs: {},
                content: website
            })));
        }
        if (args.hours !== undefined) {
            node.push({
                tag: 'business_hours',
                attrs: { timezone: args.hours.timezone },
                content: args.hours.days.map(dayConfig => {
                    const base = {
                        tag: 'business_hours_config',
                        attrs: {
                            day_of_week: dayConfig.day,
                            mode: dayConfig.mode
                        }
                    };
                    if (dayConfig.mode === 'specific_hours') {
                        return {
                            ...base,
                            attrs: {
                                ...base.attrs,
                                open_time: dayConfig.openTimeInMinutes,
                                close_time: dayConfig.closeTimeInMinutes
                            }
                        };
                    }
                    return base;
                })
            });
        }
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: {
                        v: '3',
                        mutation_type: 'delta'
                    },
                    content: node
                }
            ]
        });
        return result;
    };
    const updateCoverPhoto = async (photo) => {
        const { fileSha256, filePath } = await getRawMediaUploadData(photo, 'biz-cover-photo');
        const fileSha256B64 = fileSha256.toString('base64');
        const { meta_hmac, fbid, ts } = await waUploadToServer(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: 'biz-cover-photo'
        });
        await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: {
                        v: '3',
                        mutation_type: 'delta'
                    },
                    content: [
                        {
                            tag: 'cover_photo',
                            attrs: { id: String(fbid), op: 'update', token: meta_hmac, ts: String(ts) }
                        }
                    ]
                }
            ]
        });
        return fbid;
    };
    const removeCoverPhoto = async (id) => {
        return await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz'
            },
            content: [
                {
                    tag: 'business_profile',
                    attrs: {
                        v: '3',
                        mutation_type: 'delta'
                    },
                    content: [
                        {
                            tag: 'cover_photo',
                            attrs: { op: 'delete', id }
                        }
                    ]
                }
            ]
        });
    };
    const getCatalog = async ({ jid, limit, cursor }) => {
        jid = jid || authState.creds.me?.id;
        jid = jidNormalizedUser(jid);
        const queryParamNodes = [
            {
                tag: 'limit',
                attrs: {},
                content: Buffer.from((limit || 10).toString())
            },
            {
                tag: 'width',
                attrs: {},
                content: Buffer.from('100')
            },
            {
                tag: 'height',
                attrs: {},
                content: Buffer.from('100')
            }
        ];
        if (cursor) {
            queryParamNodes.push({
                tag: 'after',
                attrs: {},
                content: cursor
            });
        }
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog',
                    attrs: {
                        jid,
                        allow_shop_source: 'true'
                    },
                    content: queryParamNodes
                }
            ]
        });
        return parseCatalogNode(result);
    };
    const getCollections = async (jid, limit = 51) => {
        jid = jid || authState.creds.me?.id;
        jid = jidNormalizedUser(jid);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'w:biz:catalog',
                smax_id: '35'
            },
            content: [
                {
                    tag: 'collections',
                    attrs: {
                        biz_jid: jid
                    },
                    content: [
                        {
                            tag: 'collection_limit',
                            attrs: {},
                            content: Buffer.from(limit.toString())
                        },
                        {
                            tag: 'item_limit',
                            attrs: {},
                            content: Buffer.from(limit.toString())
                        },
                        {
                            tag: 'width',
                            attrs: {},
                            content: Buffer.from('100')
                        },
                        {
                            tag: 'height',
                            attrs: {},
                            content: Buffer.from('100')
                        }
                    ]
                }
            ]
        });
        return parseCollectionsNode(result);
    };
    const getOrderDetails = async (orderId, tokenBase64) => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'fb:thrift_iq',
                smax_id: '5'
            },
            content: [
                {
                    tag: 'order',
                    attrs: {
                        op: 'get',
                        id: orderId
                    },
                    content: [
                        {
                            tag: 'image_dimensions',
                            attrs: {},
                            content: [
                                {
                                    tag: 'width',
                                    attrs: {},
                                    content: Buffer.from('100')
                                },
                                {
                                    tag: 'height',
                                    attrs: {},
                                    content: Buffer.from('100')
                                }
                            ]
                        },
                        {
                            tag: 'token',
                            attrs: {},
                            content: Buffer.from(tokenBase64)
                        }
                    ]
                }
            ]
        });
        return parseOrderDetailsNode(result);
    };
    const productUpdate = async (productId, update) => {
        update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer);
        const editNode = toProductNode(productId, update);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog_edit',
                    attrs: { v: '1' },
                    content: [
                        editNode,
                        {
                            tag: 'width',
                            attrs: {},
                            content: '100'
                        },
                        {
                            tag: 'height',
                            attrs: {},
                            content: '100'
                        }
                    ]
                }
            ]
        });
        const productCatalogEditNode = getBinaryNodeChild(result, 'product_catalog_edit');
        const productNode = getBinaryNodeChild(productCatalogEditNode, 'product');
        return parseProductNode(productNode);
    };
    const productCreate = async (create) => {
        // ensure isHidden is defined
        create.isHidden = !!create.isHidden;
        create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer);
        const createNode = toProductNode(undefined, create);
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog_add',
                    attrs: { v: '1' },
                    content: [
                        createNode,
                        {
                            tag: 'width',
                            attrs: {},
                            content: '100'
                        },
                        {
                            tag: 'height',
                            attrs: {},
                            content: '100'
                        }
                    ]
                }
            ]
        });
        const productCatalogAddNode = getBinaryNodeChild(result, 'product_catalog_add');
        const productNode = getBinaryNodeChild(productCatalogAddNode, 'product');
        return parseProductNode(productNode);
    };
    const productDelete = async (productIds) => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'w:biz:catalog'
            },
            content: [
                {
                    tag: 'product_catalog_delete',
                    attrs: { v: '1' },
                    content: productIds.map(id => ({
                        tag: 'product',
                        attrs: {},
                        content: [
                            {
                                tag: 'id',
                                attrs: {},
                                content: Buffer.from(id)
                            }
                        ]
                    }))
                }
            ]
        });
        const productCatalogDelNode = getBinaryNodeChild(result, 'product_catalog_delete');
        return {
            deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
        };
    };
    return {
        ...sock,
        logger: config.logger,
        getOrderDetails,
        getCatalog,
        getCollections,
        productCreate,
        productDelete,
        productUpdate,
        updateBussinesProfile,
        updateCoverPhoto,
        removeCoverPhoto
    };
};

export const makeCommunitiesSocket = (config) => {
    const sock = makeBusinessSocket(config);
    const { authState, ev, query, upsertMessage } = sock;
    const communityQuery = async (jid, type, content) => query({
        tag: 'iq',
        attrs: {
            type,
            xmlns: 'w:g2',
            to: jid
        },
        content
    });
    const communityMetadata = async (jid) => {
        const result = await communityQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }]);
        return extractCommunityMetadata(result);
    };
    const communityFetchAllParticipating = async () => {
        const result = await query({
            tag: 'iq',
            attrs: {
                to: '@g.us',
                xmlns: 'w:g2',
                type: 'get'
            },
            content: [
                {
                    tag: 'participating',
                    attrs: {},
                    content: [
                        { tag: 'participants', attrs: {} },
                        { tag: 'description', attrs: {} }
                    ]
                }
            ]
        });
        const data = {};
        const communitiesChild = getBinaryNodeChild(result, 'communities');
        if (communitiesChild) {
            const communities = getBinaryNodeChildren(communitiesChild, 'community');
            for (const communityNode of communities) {
                const meta = extractCommunityMetadata({
                    tag: 'result',
                    attrs: {},
                    content: [communityNode]
                });
                data[meta.id] = meta;
            }
        }
        sock.ev.emit('groups.update', Object.values(data));
        return data;
    };
    async function parseGroupResult(node) {
        logger.info({ node }, 'parseGroupResult');
        const groupNode = getBinaryNodeChild(node, 'group');
        if (groupNode) {
            try {
                logger.info({ groupNode }, 'groupNode');
                const metadata = await sock.groupMetadata(`${groupNode.attrs.id}@g.us`);
                return metadata ? metadata : Optional.empty();
            }
            catch (error) {
                console.error('Error parsing group metadata:', error);
                return Optional.empty();
            }
        }
        return Optional.empty();
    }
    const Optional = {
        empty: () => null,
        of: (value) => (value !== null ? { value } : null)
    };
    sock.ws.on('CB:ib,,dirty', async (node) => {
        const { attrs } = getBinaryNodeChild(node, 'dirty');
        if (attrs.type !== 'communities') {
            return;
        }
        await communityFetchAllParticipating();
        await sock.cleanDirtyBits('groups');
    });
    return {
        ...sock,
        communityMetadata,
        communityCreate: async (subject, body) => {
            const descriptionId = generateMessageID().substring(0, 12);
            const result = await communityQuery('@g.us', 'set', [
                {
                    tag: 'create',
                    attrs: { subject },
                    content: [
                        {
                            tag: 'description',
                            attrs: { id: descriptionId },
                            content: [
                                {
                                    tag: 'body',
                                    attrs: {},
                                    content: Buffer.from(body || '', 'utf-8')
                                }
                            ]
                        },
                        {
                            tag: 'parent',
                            attrs: { default_membership_approval_mode: 'request_required' }
                        },
                        {
                            tag: 'allow_non_admin_sub_group_creation',
                            attrs: {}
                        },
                        {
                            tag: 'create_general_chat',
                            attrs: {}
                        }
                    ]
                }
            ]);
            return await parseGroupResult(result);
        },
        communityCreateGroup: async (subject, participants, parentCommunityJid) => {
            const key = generateMessageIDV2();
            const result = await communityQuery('@g.us', 'set', [
                {
                    tag: 'create',
                    attrs: {
                        subject,
                        key
                    },
                    content: [
                        ...participants.map(jid => ({
                            tag: 'participant',
                            attrs: { jid }
                        })),
                        { tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
                    ]
                }
            ]);
            return await parseGroupResult(result);
        },
        communityLeave: async (id) => {
            await communityQuery('@g.us', 'set', [
                {
                    tag: 'leave',
                    attrs: {},
                    content: [{ tag: 'community', attrs: { id } }]
                }
            ]);
        },
        communityUpdateSubject: async (jid, subject) => {
            await communityQuery(jid, 'set', [
                {
                    tag: 'subject',
                    attrs: {},
                    content: Buffer.from(subject, 'utf-8')
                }
            ]);
        },
        communityLinkGroup: async (groupJid, parentCommunityJid) => {
            await communityQuery(parentCommunityJid, 'set', [
                {
                    tag: 'links',
                    attrs: {},
                    content: [
                        {
                            tag: 'link',
                            attrs: { link_type: 'sub_group' },
                            content: [{ tag: 'group', attrs: { jid: groupJid } }]
                        }
                    ]
                }
            ]);
        },
        communityUnlinkGroup: async (groupJid, parentCommunityJid) => {
            await communityQuery(parentCommunityJid, 'set', [
                {
                    tag: 'unlink',
                    attrs: { unlink_type: 'sub_group' },
                    content: [{ tag: 'group', attrs: { jid: groupJid } }]
                }
            ]);
        },
        communityFetchLinkedGroups: async (jid) => {
            let communityJid = jid;
            let isCommunity = false;
            // Try to determine if it is a subgroup or a community
            const metadata = await sock.groupMetadata(jid);
            if (metadata.linkedParent) {
                // It is a subgroup, get the community jid
                communityJid = metadata.linkedParent;
            }
            else {
                // It is a community
                isCommunity = true;
            }
            // Fetch all subgroups of the community
            const result = await communityQuery(communityJid, 'get', [{ tag: 'sub_groups', attrs: {} }]);
            const linkedGroupsData = [];
            const subGroupsNode = getBinaryNodeChild(result, 'sub_groups');
            if (subGroupsNode) {
                const groupNodes = getBinaryNodeChildren(subGroupsNode, 'group');
                for (const groupNode of groupNodes) {
                    linkedGroupsData.push({
                        id: groupNode.attrs.id ? jidEncode(groupNode.attrs.id, 'g.us') : undefined,
                        subject: groupNode.attrs.subject || '',
                        creation: groupNode.attrs.creation ? Number(groupNode.attrs.creation) : undefined,
                        owner: groupNode.attrs.creator ? jidNormalizedUser(groupNode.attrs.creator) : undefined,
                        size: groupNode.attrs.size ? Number(groupNode.attrs.size) : undefined
                    });
                }
            }
            return {
                communityJid,
                isCommunity,
                linkedGroups: linkedGroupsData
            };
        },
        communityRequestParticipantsList: async (jid) => {
            const result = await communityQuery(jid, 'get', [
                {
                    tag: 'membership_approval_requests',
                    attrs: {}
                }
            ]);
            const node = getBinaryNodeChild(result, 'membership_approval_requests');
            const participants = getBinaryNodeChildren(node, 'membership_approval_request');
            return participants.map(v => v.attrs);
        },
        communityRequestParticipantsUpdate: async (jid, participants, action) => {
            const result = await communityQuery(jid, 'set', [
                {
                    tag: 'membership_requests_action',
                    attrs: {},
                    content: [
                        {
                            tag: action,
                            attrs: {},
                            content: participants.map(jid => ({
                                tag: 'participant',
                                attrs: { jid }
                            }))
                        }
                    ]
                }
            ]);
            const node = getBinaryNodeChild(result, 'membership_requests_action');
            const nodeAction = getBinaryNodeChild(node, action);
            const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant');
            return participantsAffected.map(p => {
                return { status: p.attrs.error || '200', jid: p.attrs.jid };
            });
        },
        communityParticipantsUpdate: async (jid, participants, action) => {
            const result = await communityQuery(jid, 'set', [
                {
                    tag: action,
                    attrs: action === 'remove' ? { linked_groups: 'true' } : {},
                    content: participants.map(jid => ({
                        tag: 'participant',
                        attrs: { jid }
                    }))
                }
            ]);
            const node = getBinaryNodeChild(result, action);
            const participantsAffected = getBinaryNodeChildren(node, 'participant');
            return participantsAffected.map(p => {
                return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p };
            });
        },
        communityUpdateDescription: async (jid, description) => {
            const metadata = await communityMetadata(jid);
            const prev = metadata.descId ?? null;
            await communityQuery(jid, 'set', [
                {
                    tag: 'description',
                    attrs: {
                        ...(description ? { id: generateMessageID() } : { delete: 'true' }),
                        ...(prev ? { prev } : {})
                    },
                    content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
                }
            ]);
        },
        communityInviteCode: async (jid) => {
            const result = await communityQuery(jid, 'get', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = getBinaryNodeChild(result, 'invite');
            return inviteNode?.attrs.code;
        },
        communityRevokeInvite: async (jid) => {
            const result = await communityQuery(jid, 'set', [{ tag: 'invite', attrs: {} }]);
            const inviteNode = getBinaryNodeChild(result, 'invite');
            return inviteNode?.attrs.code;
        },
        communityAcceptInvite: async (code) => {
            const results = await communityQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }]);
            const result = getBinaryNodeChild(results, 'community');
            return result?.attrs.jid;
        },
        /**
         * revoke a v4 invite for someone
         * @param communityJid community jid
         * @param invitedJid jid of person you invited
         * @returns true if successful
         */
        communityRevokeInviteV4: async (communityJid, invitedJid) => {
            const result = await communityQuery(communityJid, 'set', [
                { tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
            ]);
            return !!result;
        },
        /**
         * accept a CommunityInviteMessage
         * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
         * @param inviteMessage the message to accept
         */
        communityAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
            key = typeof key === 'string' ? { remoteJid: key } : key;
            const results = await communityQuery(inviteMessage.groupJid, 'set', [
                {
                    tag: 'accept',
                    attrs: {
                        code: inviteMessage.inviteCode,
                        expiration: inviteMessage.inviteExpiration.toString(),
                        admin: key.remoteJid
                    }
                }
            ]);
            // if we have the full message key
            // update the invite message to be expired
            if (key.id) {
                // create new invite message that is expired
                inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage);
                inviteMessage.inviteExpiration = 0;
                inviteMessage.inviteCode = '';
                ev.emit('messages.update', [
                    {
                        key,
                        update: {
                            message: {
                                groupInviteMessage: inviteMessage
                            }
                        }
                    }
                ]);
            }
            // generate the community add message
            await upsertMessage({
                key: {
                    remoteJid: inviteMessage.groupJid,
                    id: generateMessageIDV2(sock.user?.id),
                    fromMe: false,
                    participant: key.remoteJid // TODO: investigate if this makes any sense at all
                },
                messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
                messageStubParameters: [JSON.stringify(authState.creds.me)],
                participant: key.remoteJid,
                messageTimestamp: unixTimestampSeconds()
            }, 'notify');
            return results.attrs.from;
        }),
        communityGetInviteInfo: async (code) => {
            const results = await communityQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }]);
            return extractCommunityMetadata(results);
        },
        communityToggleEphemeral: async (jid, ephemeralExpiration) => {
            const content = ephemeralExpiration
                ? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
                : { tag: 'not_ephemeral', attrs: {} };
            await communityQuery(jid, 'set', [content]);
        },
        communitySettingUpdate: async (jid, setting) => {
            await communityQuery(jid, 'set', [{ tag: setting, attrs: {} }]);
        },
        communityMemberAddMode: async (jid, mode) => {
            await communityQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }]);
        },
        communityJoinApprovalMode: async (jid, mode) => {
            await communityQuery(jid, 'set', [
                { tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'community_join', attrs: { state: mode } }] }
            ]);
        },
        communityFetchAllParticipating
    };
};
export const extractCommunityMetadata = (result) => {
    const community = getBinaryNodeChild(result, 'community');
    const descChild = getBinaryNodeChild(community, 'description');
    let desc;
    let descId;
    if (descChild) {
        desc = getBinaryNodeChildString(descChild, 'body');
        descId = descChild.attrs.id;
    }
    const communityId = community.attrs.id?.includes('@')
        ? community.attrs.id
        : jidEncode(community.attrs.id || '', 'g.us');
    const eph = getBinaryNodeChild(community, 'ephemeral')?.attrs.expiration;
    const memberAddMode = getBinaryNodeChildString(community, 'member_add_mode') === 'all_member_add';
    const metadata = {
        id: communityId,
        subject: community.attrs.subject || '',
        subjectOwner: community.attrs.s_o,
        subjectTime: Number(community.attrs.s_t || 0),
        size: getBinaryNodeChildren(community, 'participant').length,
        creation: Number(community.attrs.creation || 0),
        owner: community.attrs.creator ? jidNormalizedUser(community.attrs.creator) : undefined,
        desc,
        descId,
        linkedParent: getBinaryNodeChild(community, 'linked_parent')?.attrs.jid || undefined,
        restrict: !!getBinaryNodeChild(community, 'locked'),
        announce: !!getBinaryNodeChild(community, 'announcement'),
        isCommunity: !!getBinaryNodeChild(community, 'parent'),
        isCommunityAnnounce: !!getBinaryNodeChild(community, 'default_sub_community'),
        joinApprovalMode: !!getBinaryNodeChild(community, 'membership_approval_mode'),
        memberAddMode,
        participants: getBinaryNodeChildren(community, 'participant').map(({ attrs }) => {
            return {
                // TODO: IMPLEMENT THE PN/LID FIELDS HERE!!
                id: attrs.jid,
                admin: (attrs.type || null)
            };
        }),
        ephemeralDuration: eph ? +eph : undefined,
        addressingMode: getBinaryNodeChildString(community, 'addressing_mode')
    };
    return metadata;
};
