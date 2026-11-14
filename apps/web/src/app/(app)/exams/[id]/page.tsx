import { RouteMessages } from '@/i18n/route-messages-provider';
import { ExamPage } from './exam-page';

/** One exam. Its tabs' texts come with this page only, not with the sheet and print pages under it. */
export default function Page() {
  return (
    <RouteMessages area="examDetail">
      <ExamPage />
    </RouteMessages>
  );
}
