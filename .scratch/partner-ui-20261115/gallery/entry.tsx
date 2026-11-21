import { renderToStaticMarkup } from 'react-dom/server';
import { TeamDeliveryCard } from '@/components/home/PartnerTeamCard';
import { PartnerMeetingInbox } from '@/components/home/PartnerMeetings';
import { MeetingWorkHandoffs } from '@/components/meeting/MeetingWorkHandoffs';
import { WorkIntakeQueue } from '@/components/home/WorkIntake';
import { SubSessionSummary } from '@/components/home/SubSessionSummary';
import { sentDelivery, incomingDelivery, projects } from './fixtures.mjs';

const noop = () => {};
export function renderScenes() {
  return {
    sent: renderToStaticMarkup(<TeamDeliveryCard delivery={sentDelivery as never} sent onSaved={noop} onForward={noop} />),
    incoming: renderToStaticMarkup(<TeamDeliveryCard delivery={incomingDelivery as never} sent={false} onSaved={noop} onForward={noop} />),
    meetings: renderToStaticMarkup(<PartnerMeetingInbox />),
    handoffs: renderToStaticMarkup(<MeetingWorkHandoffs />),
    status: renderToStaticMarkup(<><SubSessionSummary projects={projects as never} go={noop} /><WorkIntakeQueue scope="global" refreshHistory={noop} /></>),
  };
}
