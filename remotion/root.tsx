import React from "react";
import {Composition} from "remotion";
import {SocialCuesComingSoon} from "./social-cues-coming-soon";

const defaultCopy = {
  brandName: "Social Cues App",
  headline: "Create. Schedule. Conquer.",
  subhead: "Every platform. One you.",
  footer: "Coming soon",
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="SocialCuesComingSoon"
        component={SocialCuesComingSoon}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{...defaultCopy, variant: "square"}}
      />
      <Composition
        id="SocialCuesComingSoonSquare"
        component={SocialCuesComingSoon}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{...defaultCopy, variant: "square"}}
      />
      <Composition
        id="SocialCuesComingSoonVertical"
        component={SocialCuesComingSoon}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{...defaultCopy, variant: "vertical"}}
      />
      <Composition
        id="SocialCuesComingSoonStory"
        component={SocialCuesComingSoon}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{...defaultCopy, variant: "story"}}
      />
      <Composition
        id="SocialCuesComingSoonThumbnail"
        component={SocialCuesComingSoon}
        durationInFrames={180}
        fps={30}
        width={1280}
        height={720}
        defaultProps={{...defaultCopy, variant: "thumbnail"}}
      />
    </>
  );
};
