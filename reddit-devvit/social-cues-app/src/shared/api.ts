export type ModerationAction = 'approve' | 'remove' | 'spam' | 'lock' | 'unlock';

export type ModeratorPermission =
  | 'all'
  | 'wiki'
  | 'posts'
  | 'access'
  | 'mail'
  | 'config'
  | 'flair'
  | 'chat_operator'
  | 'chat_config'
  | 'channels'
  | 'community_chat';

export type ModerationCapabilities = Record<ModerationAction, boolean>;

type ThreadCommentBase = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
  parentId: string;
  score: number;
  permalink: string;
  locked: boolean;
  removed: boolean;
};

export type PublicThreadComment = ThreadCommentBase;

export type ModeratorThreadComment = ThreadCommentBase & {
  approved: boolean;
  spam: boolean;
  reports: number;
  reportReasons: string[];
};

export type ThreadComment = PublicThreadComment | ModeratorThreadComment;

export type AuditEvent = {
  at: string;
  actor: string;
  action: string;
  targetId: string;
  detail: string;
};

export type CommentPage = {
  sort: 'new';
  limit: 100;
  returned: number;
  hasMore: boolean;
  isPartial: boolean;
};

export type AdsManagerHandoff = {
  url: string;
  eligible: boolean;
  ineligibleReason: string | null;
  liveAdsApiEnabled: false;
  note: string;
};

type ThreadStateBase = {
  status: 'ok';
  postId: string;
  subredditName: string;
  username: string;
  commentPage: CommentPage;
  adsManagerHandoff: AdsManagerHandoff;
};

export type PublicThreadState = ThreadStateBase & {
  isModerator: false;
  thread: {
    title: string;
    permalink: string;
    locked: boolean;
    removed: boolean;
  };
  comments: PublicThreadComment[];
  summary: {
    loadedComments: number;
    unansweredLoaded: number;
  };
  signalSummary: {
    commentEvents: number;
  };
};

export type ModeratorThreadState = ThreadStateBase & {
  isModerator: true;
  moderatorPermissions: ModeratorPermission[];
  moderationCapabilities: ModerationCapabilities;
  thread: {
    title: string;
    permalink: string;
    locked: boolean;
    approved: boolean;
    removed: boolean;
    spam: boolean;
  };
  comments: ModeratorThreadComment[];
  summary: {
    loadedComments: number;
    reportedLoaded: number;
    removedLoaded: number;
    unansweredLoaded: number;
  };
  signalSummary: {
    commentEvents: number;
    reportEvents: number;
    lastSignal: {
      kind: 'comment' | 'report';
      at: string;
    } | null;
  };
  audit: AuditEvent[];
};

export type ThreadState = PublicThreadState | ModeratorThreadState;

export type ActionResponse = {
  status: 'ok';
  message: string;
  state: ThreadState;
};

export type ErrorResponse = {
  status: 'error';
  message: string;
};
