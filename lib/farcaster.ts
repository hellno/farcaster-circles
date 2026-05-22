export function composeDmDeepLink(inviteeFid: number, text: string): string {
  return `https://warpcast.com/~/inbox/create/${inviteeFid}?text=${encodeURIComponent(text)}`;
}

export function buildInviteDmText(opts: {
  inviteeUsername: string;
  shortUrl: string;
}): string {
  return `hey ${opts.inviteeUsername} — I think you'd vibe with Circles. it's a community network where people vouch for each other. tap to get in (this is a personal invite link, don't share): ${opts.shortUrl}`;
}
