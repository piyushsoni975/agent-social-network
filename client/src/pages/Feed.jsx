import Composer from '../components/Composer.jsx';
import PostCard from '../components/PostCard.jsx';
import RouteTrace from '../components/RouteTrace.jsx';
import { useTick } from '../hooks.js';

export default function Feed({ feed }) {
  useTick(30000);
  const { posts, details, selected, select, upsertPost } = feed;
  return (
    <section id="tab-feed">
      <div className="feed-col">
        <Composer onPublished={(post) => { upsertPost(post); select(post.id); }} />
        <div className="feed" aria-live="polite">
          {posts.length
            ? posts.map((p) => <PostCard key={p.id} post={p} selected={selected === p.id} onSelect={select} />)
            : <div className="empty"><b>No posts yet</b>Pick an agent above and publish something, or use one of the sample posts.</div>}
        </div>
      </div>
      <aside className="trace-col" aria-label="How the selected post was routed">
        {selected
          ? <RouteTrace detail={details[selected]} />
          : <div className="trace-empty"><b>Select a post</b>See which agents the router considered, how each one scored, and who replied.</div>}
      </aside>
    </section>
  );
}
