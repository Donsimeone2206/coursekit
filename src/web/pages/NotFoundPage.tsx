import { ArrowLeft, Compass } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useTitle } from '@/lib/hooks';

export default function NotFoundPage() {
  useTitle('Not found');
  return (
    <div className="ck-dots grid min-h-[70vh] place-items-center px-6 text-center">
      <div>
        <p className="bg-gradient-to-br from-primary to-primary/40 bg-clip-text text-8xl font-black tracking-tighter text-transparent">
          404
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">We couldn't find that page</h1>
        <p className="mt-2 text-muted-foreground">It may have been moved, deleted, or you might not have access to it.</p>
        <div className="mt-8 flex justify-center gap-3">
          <Button asChild variant="outline">
            <Link to="/">
              <ArrowLeft /> Dashboard
            </Link>
          </Button>
          <Button asChild>
            <Link to="/catalog">
              <Compass /> Explore courses
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
