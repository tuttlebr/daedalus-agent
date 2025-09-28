import { GetServerSideProps } from 'next';
import { LoginPage } from '@/components/Auth/LoginPage';

export default function Login() {
  return <LoginPage />;
}

export const getServerSideProps: GetServerSideProps = async ({ locale }) => {
  return {
    props: {
      ...(await import(`../public/locales/${locale || 'en'}/common.json`)).default,
    },
  };
};
