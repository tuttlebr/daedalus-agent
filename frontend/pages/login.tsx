import { GetServerSideProps } from 'next';
import { LoginPage } from '@/components/auth';

export default function Login() {
  return <LoginPage />;
}

export const getServerSideProps: GetServerSideProps = async ({ locale, query, res }) => {
  // SECURITY: Reject credential query parameters at server-side
  if (query.username || query.password) {
    console.warn('[SECURITY] Credential query parameters detected on login page', {
      hasUsername: !!query.username,
      hasPassword: !!query.password,
      timestamp: new Date().toISOString(),
    });

    return {
      redirect: {
        destination: '/login',
        permanent: false,
      },
    };
  }

  return {
    props: {
      ...(await import(`../public/locales/${locale || 'en'}/common.json`)).default,
    },
  };
};
