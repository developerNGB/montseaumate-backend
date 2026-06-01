import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const FIREBASE_PROJECT_ID_FALLBACK = 'project-62bc5c10-6bba-401a-b93';

function getFirebaseProjectId() {
    return (
        process.env.FIREBASE_PROJECT_ID?.trim() ||
        process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        FIREBASE_PROJECT_ID_FALLBACK
    );
}

function getFirebaseAdminOptions() {
    const projectId = getFirebaseProjectId();
    if (!projectId) {
        throw new Error(
            'Firebase project ID is missing. Set FIREBASE_PROJECT_ID, VITE_FIREBASE_PROJECT_ID, or GOOGLE_CLOUD_PROJECT.'
        );
    }

    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (clientEmail && privateKey) {
        return {
            credential: cert({
                projectId,
                clientEmail,
                privateKey,
            }),
            projectId,
        };
    }

    return { projectId };
}

function getFirebaseAdminApp() {
    if (getApps().length) {
        return getApp();
    }

    return initializeApp(getFirebaseAdminOptions());
}

export async function verifyFirebaseIdToken(idToken) {
    return getAuth(getFirebaseAdminApp()).verifyIdToken(idToken);
}
