import { reddit } from '@devvit/web/server';
import { registerCommandThread } from './thread-registry';

export const createPost = async () => {
  const post = await reddit.submitCustomPost({
    title: 'Social Cues Community Command',
    entry: 'default',
    runAs: 'APP',
    postData: { kind: 'social-cues-community-command', version: 1 },
    textFallback: {
      text: 'Social Cues community command center: review replies, moderate with explicit approval, and prepare an Ads Manager handoff.',
    },
  });
  await registerCommandThread(post.id);
  return post;
};
