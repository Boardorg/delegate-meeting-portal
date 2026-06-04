import { loadAttendees } from '@/lib/attendees/loader';
import SponsorCatalog from '@/app/components/SponsorCatalog';

export default async function Home() {
    const attendees = await loadAttendees();
    const delegates = attendees.filter(a => a.role === 'delegate');
    const sponsors = attendees.filter(a => a.role === 'sponsor');

    // TODO: map the session phone number to the correct sponsor record once
    // a phone field is added to Attendee. For now, default to the first sponsor.
    const currentSponsor = sponsors[0] ?? attendees[0];

    return <SponsorCatalog delegates={delegates} currentSponsor={currentSponsor} />;
}
