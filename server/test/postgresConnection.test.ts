import { rootCertificates } from 'node:tls';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { postgresConnection } from '../src/db/connection.js';

const remote =
    'postgresql://test_user:test_password@jimbrownhome1/ferry_tracker?hostaddr=192.168.2.14&sslmode=verify-full&sslrootcert=C%3A%5CProtected%5Cpg-ca.pem&gssencmode=disable';
it('pins actual driver TCP host while preserving verified TLS DNS identity without connecting', () => {
    const config = postgresConnection(remote, () => rootCertificates[0]);
    const client = new Client(config);
    expect(client.host).toBe('192.168.2.14');
    expect(client.ssl).toEqual({ ca: rootCertificates[0], servername: 'jimbrownhome1', rejectUnauthorized: true });
    expect(config.connectionString).toBeUndefined();
    expect(config.database).toBe('ferry_tracker');
    for (const address of ['10.2.3.4', '172.16.2.3', '100.64.2.3']) {
        expect(postgresConnection(remote.replace('192.168.2.14', address), () => rootCertificates[0]).host).toBe(
            address
        );
    }
});
it('keeps query-free loopback URLs and rejects remote policy bypasses before network access', () => {
    const local = 'postgresql://test:password@127.0.0.1:45678/sd_test_ferry';
    expect(postgresConnection(local)).toEqual({ connectionString: local });
    for (const invalid of [
        remote.replace('192.168.2.14', '8.8.8.8'),
        remote.replace('verify-full', 'require'),
        remote.replace('jimbrownhome1/', 'public.example/'),
        `${remote}&host=evil`,
        `${remote}&hostaddr=192.168.2.14`,
        remote.replace('gssencmode=disable', 'gssencmode=prefer'),
        remote.replace('C%3A%5CProtected%5Cpg-ca.pem', 'relative.pem'),
        remote.replace('C%3A%5CProtected%5Cpg-ca.pem', '%5C%5Cserver%5Cshare%5Cca.pem'),
        remote.replace('hostaddr=192.168.2.14', 'hostaddr=192.168.2.14,192.168.2.15'),
        ...['127.0.0.1', '224.0.0.1', '192.168.02.14', '192.168.2.999', '100.128.0.1', '172.32.0.1', '169.254.1.1'].map(
            (address) => remote.replace('192.168.2.14', address)
        ),
    ])
        expect(() => postgresConnection(invalid, () => rootCertificates[0])).toThrow();
    expect(() => postgresConnection(remote, () => 'invalid certificate')).toThrow('CA certificate');
    expect(() =>
        postgresConnection(remote, () => {
            throw new Error('private path');
        })
    ).toThrow('CA certificate');
});
