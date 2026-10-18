import { redirect } from 'next/navigation';

/** The old "classes and sections" placeholder; that lives in institute setup now. */
export default function Page() {
  redirect('/setup/classes');
}
