import { bookingConfirmation, bookingReminder } from './booking-messages.js';
import { inboxAssist } from './inbox-assist.js';
import { jobPhotoReport, reviewReply } from './discovery.js';
import { paymentReceipt, paymentRecovery, paymentRequest } from './payments.js';
import { atRiskCheckin, firstVisitCheckin, referralAsk, winBack } from './retention.js';
import { leadResponse } from './lead-response.js';
import { missedCallTextback } from './missed-call-textback.js';
import { reviewRequest } from './review-request.js';
import type { Playbook } from './types.js';

export const PLAYBOOKS: Playbook[] = [missedCallTextback, leadResponse, reviewRequest, inboxAssist, bookingConfirmation, bookingReminder, paymentRequest, paymentReceipt, paymentRecovery,
  firstVisitCheckin, atRiskCheckin, winBack, referralAsk, reviewReply, jobPhotoReport];
export const playbookByKey = (key: string) => PLAYBOOKS.find((p) => p.key === key);
