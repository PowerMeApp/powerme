/** Screen 30 — Card Registry & Free-Vend Tags (UC-ADM-04/05): thẻ online / ví, tag free vend theo trụ. */
import { Card, Loading, PageHeader, Pill } from '../../components/ui';
import { useCardsQuery, useFreeVendTagsQuery } from '../../core/api/api';

export function CardRegistryPage() {
  const { data: cards, isLoading } = useCardsQuery();
  const { data: tags } = useFreeVendTagsQuery();
  return (
    <>
      <PageHeader
        title="Thẻ RFID & free vend"
        subtitle="Thẻ online trừ Charging Credit; thẻ ví trả tại trụ, CSMS không thu tiền (ADR-0012)"
      />
      {isLoading ? (
        <Loading />
      ) : (
        <div className="grid cols-2">
          <Card title="Thẻ RFID" extra={<small>{cards?.length ?? 0} thẻ</small>}>
            <table className="table">
              <thead>
                <tr>
                  <th>UID</th>
                  <th>Loại</th>
                  <th>Chủ thẻ</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {(cards ?? []).map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.uid}</td>
                    <td>
                      <Pill tone={c.type === 'online' ? 'teal' : 'gold'}>
                        {c.type === 'online' ? 'Online' : 'Ví tại trụ'}
                      </Pill>
                    </td>
                    <td>{c.holder ?? '—'}</td>
                    <td>
                      {c.status === 'active' ? (
                        <Pill tone="teal">Hoạt động</Pill>
                      ) : (
                        <Pill tone="danger">Đã khoá</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Tag free vend theo trụ">
            <table className="table">
              <thead>
                <tr>
                  <th>Trụ</th>
                  <th>Tag</th>
                </tr>
              </thead>
              <tbody>
                {(tags ?? []).map((t) => (
                  <tr key={t.serial}>
                    <td className="mono">{t.serial}</td>
                    <td className="mono">{t.tag}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint">
              Phiên free vend không có người trả tiền — vào dòng doanh thu riêng.
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
