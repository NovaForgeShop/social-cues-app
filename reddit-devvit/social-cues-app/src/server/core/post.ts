import { reddit } from '@devvit/web/server';
import { COMMAND_THREAD_POST_DATA, registerCommandThread } from './thread-registry';

export const createPost = async () => {
  const post = await reddit.submitCustomPost({
    title: 'Social Cues Community Command',
    entry: 'default',
    runAs: 'APP',
    postData: COMMAND_THREAD_POST_DATA,
    textFallback: {
      text: 'Social Cues community command center: review replies, moderate with explicit approval, and prepare an Ads Manager handoff.',
    },
  });
  await registerCommandThread(post.id);
  return post;
};
