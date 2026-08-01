-- Shorts-derivation Phase 2 (SHORTS-DERIVATION-SPEC §1/§7): a subchannel's
-- publish-AUTH pointer. When set, the channel's Shorts upload to the pointed-at
-- channel's YouTube account (Mode 1, "parent-youtube"); when null, the channel
-- uses its own token (Mode 2, "own-youtube"). Resolved by
-- resolveYoutubeAuthChannelId → loadChannelToken at publish/analytics time.
ALTER TABLE "channels" ADD COLUMN "youtube_auth_channel_id" text;
