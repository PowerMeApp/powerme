import 'package:intl/intl.dart';

abstract final class AppFormatters {
  static final _money = NumberFormat.currency(
    locale: 'vi_VN',
    symbol: '₫',
    decimalDigits: 0,
  );
  static final _time = DateFormat('HH:mm', 'vi_VN');
  static final _date = DateFormat('dd/MM/yyyy HH:mm', 'vi_VN');

  static String money(int amount) => _money.format(amount);

  static String clock(DateTime value) => _time.format(value.toLocal());

  static String dateTime(DateTime value) => _date.format(value.toLocal());

  static String kwh(int wh) => '${(wh / 1000).toStringAsFixed(2)} kWh';
}
