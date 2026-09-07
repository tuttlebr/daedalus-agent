import { GetServerSideProps } from 'next';
import Head from 'next/head';

import { LoginPage } from '@/components/auth';

export default function Login() {
  return (
    <>
      <Head>
        <title>Sign in · Daedalus</title>
      </Head>
      <LoginPage />
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async ({ query }) => {
  // SECURITY: Reject credential query parameters at server-side
  if (query.username || query.password) {
    console.warn(
      '[SECURITY] Credential query parameters detected on login page',
      {
        hasUsername: !!query.username,
        hasPassword: !!query.password,
        timestamp: new Date().toISOString(),
      },
    );

    return {
      redirect: {
        destination: '/login',
        permanent: false,
      },
    };
  }

  return { props: {} };
};
